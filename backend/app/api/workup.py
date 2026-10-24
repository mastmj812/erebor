"""Single-location BOX workup (Map tab, bottom window "Workup"): how ONE location's
record-run forecast was built, rendered on demand from box.* (D80: the database is the
record; this is a render). Read-only, like the rest of erebor.

  GET /api/box/location?basin=&stick_id=   (stick_id > 0: a Novi stick location; PDP rows
                                            carry -(api10) and have no BOX forecast, rule 8)

What it answers for the clicked location:
  * the build chain, per stream — reproduces the stored EUR exactly (verified live on all
    42,475 run-14 forecast rows, 2026-10-21; read from the stored row, so run 19 too):
        EUR = cohort P50 per 1,000 ft x lateral multiplier x haircut x proximity factor
        EUR per ft = EUR / lateral
    The lateral multiplier is the stored one: on a D121 run (19) every cohort is Cui & Cross-
    translated from its analogs' laterals; before, lateral / 1,000 except below 7,500 ft (D50).
    The haircut is the group's walk-forward factor (D62 / D92): on run 19 WCA oil and BS2_S
    oil + gas only (D121 / D122), 1.0 everywhere else; the proximity factor is the D113
    multi-parent oil factor (1.0 when as-is). The stored EUR already carries all of it.
  * the type curve: per-stream params (qi, Di nominal AND 1-yr effective, b, Df, peak
    month) and the monthly forecast per 1,000 ft on the ANALOG basis (volume / lateral
    multiplier = cohort P50 x haircut x proximity), against each named analog's calendar
    actuals per 1,000 ft of its own lateral (carries downtime; the forecast is uptime-free,
    D63) and their P10 (HIGH) / P50 / P90 (LOW) band;
  * the cohort: who the analogs are, how far, how long their laterals, and BOX's own flags
    (under_count, at-bound fits, the tier sentence);
  * context the cohort does not show: same-bench producers nearby that are NOT analogs, and
    same-bench BOX neighbours (their per-ft, analog count, search radius) — the comparison
    that explains a location reading far off its neighbours;
  * PDP proximity (outcome, configuration, named parents) and the group's tier / haircut
    disclosure.

Every BOX attribute is read through app.box_locations (box_joins / map_coverage_sql); a
location without a BOX forecast returns its class and nothing valued (never a zero).
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.api.box import (
    PROX_OUTCOME_TEXT,
    SERIES_STREAMS,
    band,
    config_line,
    group_blocks,
    group_of,
    months_between,
    run_groups,
    water_fields,
)
from app.box_locations import FORECAST_CLASSES, SEARCHED_CLASSES, TIER_OF, box_joins, map_coverage_sql, record_run
from app.db import get_session

router = APIRouter(prefix="/box", tags=["box"])

K_MONTHS = 120            # months on the workup chart (forecast and analog actuals)
NEARBY_PDP_MI = 2.0       # same-bench producers NOT in the cohort, shown for context
NEIGHBOUR_MI = 1.0        # same-bench BOX locations shown for comparison
NEARBY_LIMIT = 12
FT_PER_MI = 5280.0
CUI_CROSS_BELOW_FT = 7500.0  # D50: below this the lateral multiplier is Cui & Cross, not linear
# prefilter boxes in degrees (geometry GiST index); the real cut is the geography distance
_DEG_PREFILTER = {NEARBY_PDP_MI: 0.045, NEIGHBOUR_MI: 0.025}
_PROD_COL = {"oil": "oil_per_month_bbl", "gas": "gas_per_month_mcf", "water": "water_per_month_bbl"}
_UNDER_COUNT = re.compile(r"under_count:\s*(\d+)\s*<\s*min_wells\s*(\d+)")


# ---------------------------------------------------------------------------
# pure helpers (DB-free, tested)
# ---------------------------------------------------------------------------
def build_chain(s: dict[str, Any], lateral_ft: float | None) -> dict[str, Any] | None:
    """One stream's EUR as the product it is stored as. `s` = its box.pud_forecast_stream
    row (eur_raw, eur_haircut, prox_factor, lateral_mult, eur, eur_per_kft). None when
    the stream carries no EUR. `check` = the product reproduces the stored EUR (< 0.1 %)."""
    if s.get("eur") is None or s.get("eur_raw") is None or not s.get("lateral_mult"):
        return None
    mult = float(s["lateral_mult"])
    haircut = float(s["eur_haircut"] if s.get("eur_haircut") is not None else 1.0)
    prox = float(s["prox_factor"] if s.get("prox_factor") is not None else 1.0)
    cohort_per_kft = float(s["eur_raw"]) / mult
    product = cohort_per_kft * mult * haircut * prox
    linear = lateral_ft / 1000.0 if lateral_ft else None
    eur = float(s["eur"])
    return {
        "cohort_p50_per_kft": cohort_per_kft,
        "lateral_mult": mult,
        "linear_mult": linear,
        "cui_cross": linear is not None and abs(mult - linear) > 0.01,
        "haircut": haircut,
        "prox_factor": prox,
        "eur": eur,
        "eur_per_ft": (eur / lateral_ft) if lateral_ft else None,
        "check": abs(product / eur - 1.0) < 1e-3 if eur else product == 0,
    }


def actual_monthly_per_kft(rows: list[dict[str, Any]], first: dt.date, lateral_ft: float,
                           data_through: dt.date, k: int = K_MONTHS) -> list[float | None]:
    """One producer's calendar monthly volume per 1,000 ft for months 1..k, anchored on its
    first production month. A month with no report before data_through counts as zero;
    months after data_through are None (not yet observed). Each row: prod_date, v."""
    vol = np.zeros(k)
    for r in rows:
        m = months_between(first, r["prod_date"])
        if 1 <= m <= k:
            vol[m - 1] += float(r["v"] or 0.0)
    per = vol / (lateral_ft / 1000.0)
    seen = min(k, max(0, months_between(first, data_through)))
    return [float(v) if i < seen else None for i, v in enumerate(per)]


def cum_at(monthly: list[float | None], m: int) -> float | None:
    """Cumulative of the first m months, or None when month m is not observed."""
    if len(monthly) < m or any(v is None for v in monthly[:m]):
        return None
    return float(sum(monthly[:m]))  # type: ignore[arg-type]


def band_monthly(curves: list[list[float | None]], min_n: int = 3) -> dict[str, Any] | None:
    """P10 (HIGH) / P50 / P90 (LOW) of the analogs' CUMULATIVE per 1,000 ft per month
    (app.api.box.band; SPE convention, P10 = the high value)."""
    if len(curves) < min_n:
        return None
    cums = []
    for c in curves:
        a = np.array([np.nan if v is None else v for v in c], dtype=float)
        cums.append(np.cumsum(a))  # NaN from the first unobserved month on
    return band(cums, min_n)


def cohort_notes(loc: dict[str, Any], analogs: list[dict[str, Any]], nearby: list[dict[str, Any]],
                 neighbours: list[dict[str, Any]], oil_per_ft: float | None) -> list[str]:
    """Plain sentences on what shapes this location's cohort — facts, no verdicts."""
    notes: list[str] = []
    for f in loc.get("flags") or []:
        m = _UNDER_COUNT.search(f)
        if m:
            notes.append(f"Thin cohort: {m.group(1)} analogs where the run wants at least {m.group(2)} "
                         f"(the run flagged it under_count and kept the forecast).")
    if analogs:
        near = min(a["dist_ft"] for a in analogs) / FT_PER_MI
        far = max(a["dist_ft"] for a in analogs) / FT_PER_MI
        notes.append(f"Analogs sit {near:.1f}–{far:.1f} mi away (search radius reached {loc.get('radius_mi') or 0:g} mi, "
                     f"{loc.get('search_mode') or 'search'}).")
        lats = sorted(a["lateral_ft"] for a in analogs if a.get("lateral_ft"))
        lat = loc.get("lateral_ft")
        if lats and lat:
            med = lats[len(lats) // 2]
            notes.append(f"Analog laterals {lats[0]:,.0f}–{lats[-1]:,.0f} ft (median {med:,.0f}) vs this location's "
                         f"{lat:,.0f} ft ({lat / med:.2f}×); per-ft scaling assumes its extra foot performs like "
                         f"the analogs' average foot.")
    if nearby:
        lats = sorted(n["lateral_ft"] for n in nearby if n.get("lateral_ft"))
        lat_txt = "" if not lats else (f"; lateral {lats[0]:,.0f} ft" if lats[0] == lats[-1]
                                       else f"; their laterals {lats[0]:,.0f}–{lats[-1]:,.0f} ft")
        notes.append(f"{len(nearby)} same-bench producer{'s' if len(nearby) != 1 else ''} within "
                     f"{NEARBY_PDP_MI:g} mi {'are' if len(nearby) != 1 else 'is'} NOT in the cohort (closest "
                     f"{nearby[0]['dist_ft'] / FT_PER_MI:.1f} mi{lat_txt}). BOX's analog rules (bench, lateral band, "
                     f"vintage, months on production) decide membership.")
    vals = sorted(n["oil_eur_ft"] for n in neighbours if n.get("oil_eur_ft") is not None)
    if vals and oil_per_ft:
        med = vals[len(vals) // 2]
        notes.append(f"Same-bench BOX neighbours within {NEIGHBOUR_MI:g} mi: median oil {med:.1f} bbl/ft "
                     f"vs this location's {oil_per_ft:.1f} ({oil_per_ft / med:.2f}×).")
    return notes


def _clean(v: Any) -> Any:
    return None if isinstance(v, float) and not math.isfinite(v) else v


# ---------------------------------------------------------------------------
# endpoint
# ---------------------------------------------------------------------------
_LOC_SQL = f"""
SELECT w.stick_id, w.unique_id, w.formation_blueox, w.operator, w.ll_ft, w.tvd, w.pad_name,
       {map_coverage_sql('w')} AS coverage,
       bp.location_id, bp.lateral_ft, bp.completed_lateral_ft, bp.planned_spacing_ft, bp.spacing_source,
       bp.search_mode, bp.radius_mi, bp.radius_class, bp.n_analogs, bp.short_lateral, bp.flags, bp.extent_id,
       bpp.outcome AS prox_outcome, bpp.config_class AS prox_config_class, bpp.factor AS prox_factor,
       bpp.label AS prox_label, bpp.n_same AS prox_n_same, bpp.n_topfill AS prox_n_topfill,
       bpp.n_underfill AS prox_n_underfill, bpp.n_parents_total AS prox_n_parents_total,
       bpp.flanked_same AS prox_flanked_same, bpp.flanked_topfill AS prox_flanked_topfill,
       bpp.flanked_underfill AS prox_flanked_underfill,
       ST_AsGeoJSON(w.wellstick_geom) AS geom
FROM curated.erebor_locations w
{box_joins('w', bench='w.formation_blueox')}
WHERE w.basin = :basin AND w.stick_id = :sid AND w.category <> 'PDP'
"""

_STREAMS_SQL = """
SELECT stream, params, lateral_mult, eur_haircut, eur_raw, eur, eur_per_kft, cum12, cum24, tier, prox_factor
FROM box.pud_forecast_stream WHERE run_id = :r AND location_id = :loc
"""

_MONTHS_SQL = """
SELECT stream, month_no, volume FROM box.pud_forecast_month
WHERE run_id = :r AND location_id = :loc AND month_no <= :k ORDER BY stream, month_no
"""

# the cohort, with each analog's own geometry + bench (PDP rows carry stick_id = -(api10))
_ANALOGS_SQL = """
SELECT la.rank, la.api10, la.dist_ft, la.lateral_ft, la.first_production, la.transfer,
       w.well_name, w.current_operator AS operator, el.formation_blueox,
       ST_AsGeoJSON(el.wellstick_geom) AS geom
FROM box.location_analog la
LEFT JOIN curated.wells w ON w.api10 = la.api10
LEFT JOIN curated.erebor_locations el ON el.stick_id = -(la.api10::bigint)
WHERE la.run_id = :r AND la.location_id = :loc
ORDER BY la.rank
"""

_WATER_ANALOGS_SQL = """
SELECT a.api10, a.dist_ft, a.water_label, a.first_production, we.lateral_length_ft AS lateral_ft
FROM box.location_water_analog a
LEFT JOIN curated.wells_enriched we ON we.api10 = a.api10
WHERE a.run_id = :r AND a.location_id = :loc ORDER BY a.rank
"""

# same-bench producers within NEARBY_PDP_MI that are not analogs (GiST prefilter in degrees,
# then the true geography distance)
_NEARBY_PDP_SQL = """
WITH me AS (SELECT wellstick_geom AS g FROM curated.erebor_locations WHERE stick_id = :sid)
SELECT (-el.stick_id)::text AS api10, COALESCE(cw.well_name, el.unique_id) AS well_name,
       COALESCE(cw.current_operator, el.operator) AS operator, el.ll_ft AS lateral_ft,
       we.first_production_date AS first_production,
       ST_Distance(el.wellstick_geom::geography, me.g::geography) AS dist_ft_m,
       ST_AsGeoJSON(el.wellstick_geom) AS geom
FROM me
JOIN curated.erebor_locations el ON ST_DWithin(el.wellstick_geom, me.g, :deg)
LEFT JOIN LATERAL (SELECT first_production_date FROM curated.wells_enriched
                   WHERE api10 = (-el.stick_id)::text LIMIT 1) we ON true
LEFT JOIN curated.wells cw ON cw.api10 = (-el.stick_id)::text
WHERE el.basin = :basin AND el.category = 'PDP' AND el.formation_blueox = :bench
  AND NOT ((-el.stick_id)::text IN :analogs)
ORDER BY dist_ft_m
LIMIT :lim
"""

# same-bench BOX locations within NEIGHBOUR_MI (their per-ft and how their cohort was found)
_NEIGHBOURS_SQL = """
WITH me AS (SELECT wellstick_geom AS g FROM curated.erebor_locations WHERE stick_id = :sid)
SELECT el.stick_id, el.unique_id, bp.coverage, bp.lateral_ft, bp.n_analogs, bp.radius_mi,
       s.eur_per_kft / 1000.0 AS oil_eur_ft, s.prox_factor,
       ST_Distance(el.wellstick_geom::geography, me.g::geography) AS dist_ft_m
FROM me
JOIN curated.erebor_locations el ON ST_DWithin(el.wellstick_geom, me.g, :deg)
JOIN box.pud_forecast bp ON bp.run_id = :r AND bp.stick_id = el.stick_id
LEFT JOIN box.pud_forecast_stream s ON s.run_id = bp.run_id AND s.location_id = bp.location_id AND s.stream = 'oil'
WHERE el.basin = :basin AND el.category <> 'PDP' AND el.formation_blueox = :bench AND el.stick_id <> :sid
ORDER BY dist_ft_m
LIMIT :lim
"""


def _feature(geom: str | None, **props: Any) -> dict[str, Any] | None:
    return None if geom is None else {"type": "Feature", "geometry": json.loads(geom), "properties": props}


@router.get("/location")
def location(
    basin: str = Query(..., pattern="^(delaware|midland)$"),
    stick_id: int = Query(..., gt=0),
    session: Session = Depends(get_session),
) -> dict:
    run = record_run(session)
    r = run["run_id"]
    row = session.execute(text(_LOC_SQL), {"basin": basin, "sid": stick_id, "box_run": r}).mappings().first()
    if row is None:
        raise HTTPException(404, "no Novi stick location with that id in this basin")
    loc = {k: v for k, v in dict(row).items() if not k.startswith("prox_") and k != "geom"}
    loc["tier"] = TIER_OF.get(loc["coverage"])
    groups = run_groups(run)
    loc["group"] = group_of(loc["formation_blueox"], groups) if loc["coverage"] in SEARCHED_CLASSES else None
    out: dict[str, Any] = {
        "run": {k: run[k] for k in ("run_id", "report_version", "data_through", "created_at")},
        "location": loc, "streams": {}, "chain": {}, "chart": None,
        "analogs": [], "nearby_pdp": [], "neighbours": [], "notes": [],
        "proximity": None, "group": None, "water": None,
        "geo": {"type": "FeatureCollection", "features": [f for f in [_feature(row["geom"], role="location")] if f]},
    }
    if loc["group"]:
        blocks = group_blocks(run, {loc["group"]}, {loc["radius_class"]} if loc["radius_class"] else None)
        out["group"] = blocks[0] if blocks else None

    # PDP proximity (sql/65): the outcome and its named parents
    if row["prox_outcome"] is not None:
        prox = {k.removeprefix("prox_"): row[k] for k in row.keys() if k.startswith("prox_")}
        parents = [dict(p) for p in session.execute(text("""
            SELECT pp.api10, pp.cls, pp.parent_bench, pp.dv_ft, pp.dh_ft, pp.overlap, pp.age_days, pp.permit,
                   w.well_name, w.current_operator AS operator
            FROM box.pud_proximity_parent pp LEFT JOIN curated.wells w ON w.api10 = pp.api10
            WHERE pp.run_id = :r AND pp.location_id = :loc ORDER BY pp.dh_ft
        """), {"r": r, "loc": row["location_id"]}).mappings()]
        out["proximity"] = {"outcome": prox["outcome"], "outcome_text": PROX_OUTCOME_TEXT.get(prox["outcome"], prox["outcome"]),
                            "factor": prox["factor"], "label": prox["label"], "config_class": prox["config_class"],
                            "config_line": config_line(prox, parents), "parents": parents}

    if loc["coverage"] not in SEARCHED_CLASSES:
        return out  # no search, no forecast: the class says why (never a zero)

    data_through = dt.date.fromisoformat(run["data_through"])
    analogs = [dict(a) for a in session.execute(text(_ANALOGS_SQL), {"r": r, "loc": row["location_id"]}).mappings()]
    bench = loc["formation_blueox"]
    nearby: list[dict[str, Any]] = []
    neighbours: list[dict[str, Any]] = []
    if bench:
        nearby = [dict(n) for n in session.execute(
            text(_NEARBY_PDP_SQL).bindparams(bindparam("analogs", expanding=True)),
            {"sid": stick_id, "basin": basin, "bench": bench, "deg": _DEG_PREFILTER[NEARBY_PDP_MI],
             "analogs": [a["api10"] for a in analogs] or ["-"], "lim": NEARBY_LIMIT},
        ).mappings()]
        nearby = [n for n in nearby if n["dist_ft_m"] / 0.3048 <= NEARBY_PDP_MI * FT_PER_MI]
        neighbours = [dict(n) for n in session.execute(text(_NEIGHBOURS_SQL), {
            "sid": stick_id, "basin": basin, "bench": bench, "r": r,
            "deg": _DEG_PREFILTER[NEIGHBOUR_MI], "lim": NEARBY_LIMIT}).mappings()]
        neighbours = [n for n in neighbours if n["dist_ft_m"] / 0.3048 <= NEIGHBOUR_MI * FT_PER_MI]
    for n in nearby + neighbours:
        n["dist_ft"] = n.pop("dist_ft_m") / 0.3048

    # actual production of the analogs + the nearby non-analogs (one query)
    water_rows = []
    if loc["coverage"] in FORECAST_CLASSES:
        water_rows = [dict(w) for w in session.execute(text(_WATER_ANALOGS_SQL), {"r": r, "loc": row["location_id"]}).mappings()]
    measured_water = [w for w in water_rows if w["water_label"] == "measured" and w["first_production"] and w["lateral_ft"]]
    apis = sorted({a["api10"] for a in analogs} | {n["api10"] for n in nearby} | {w["api10"] for w in measured_water})
    prod: dict[str, list[dict[str, Any]]] = {}
    if apis:
        for p in session.execute(text("""
                SELECT api10, prod_date, oil_per_month_bbl AS oil, gas_per_month_mcf AS gas, water_per_month_bbl AS water
                FROM curated.production WHERE api10 IN :api AND prod_date <= :thru
            """).bindparams(bindparam("api", expanding=True)), {"api": apis, "thru": data_through}).mappings():
            prod.setdefault(p["api10"], []).append(dict(p))

    def series(api10: str, first: dt.date | None, lat: float | None, stream: str) -> list[float | None] | None:
        if not first or not lat or api10 not in prod:
            return None
        return actual_monthly_per_kft([{"prod_date": p["prod_date"], "v": p[stream]} for p in prod[api10]],
                                      first, float(lat), data_through)

    for a in analogs:
        a["actual"] = {s: series(a["api10"], a["first_production"], a["lateral_ft"], s) for s in ("oil", "gas", "water")}
        oil = a["actual"]["oil"]
        a["oil_cum12_per_kft"] = cum_at(oil, 12) if oil else None
        a["oil_cum24_per_kft"] = cum_at(oil, 24) if oil else None
        a["months_observed"] = max(0, months_between(a["first_production"], data_through)) if a["first_production"] else None
        f = _feature(a.pop("geom"), role="analog", api10=a["api10"], rank=a["rank"], name=a["well_name"])
        if f:
            out["geo"]["features"].append(f)
    for n in nearby:
        oil = series(n["api10"], n["first_production"], n["lateral_ft"], "oil")
        n["oil_cum12_per_kft"] = cum_at(oil, 12) if oil else None
        n["months_observed"] = max(0, months_between(n["first_production"], data_through)) if n["first_production"] else None
        f = _feature(n.pop("geom"), role="nearby", api10=n["api10"], name=n["well_name"])
        if f:
            out["geo"]["features"].append(f)

    # the forecast (forecast classes only): stream rows, chain, type curve on the analog basis
    oil_per_ft = None
    if loc["coverage"] in FORECAST_CLASSES:
        srows = {s["stream"]: dict(s) for s in session.execute(text(_STREAMS_SQL), {"r": r, "loc": row["location_id"]}).mappings()}
        for st, s in srows.items():
            prm = s.get("params") or {}
            out["streams"][st] = {
                "tier": s["tier"], "eur": s["eur"], "eur_per_kft": s["eur_per_kft"], "cum12": s["cum12"], "cum24": s["cum24"],
                "qi": prm.get("qi"), "di_nominal": prm.get("Di_nominal"), "di_eff_1yr": prm.get("Di_eff_1yr"),
                "b": prm.get("b"), "df": prm.get("Df"), "model_type": prm.get("model_type"),
                "peak_month": prm.get("peak_index_months"), "basis": prm.get("basis"),
                "haircut_method": (prm.get("haircut") or {}).get("method"),
            }
            out["chain"][st] = build_chain(s, loc["lateral_ft"])
        if out["chain"].get("oil"):
            oil_per_ft = out["chain"]["oil"]["eur_per_ft"]
        if "water" in srows:
            out["water"] = water_fields(srows["water"].get("params"), srows["water"].get("cum12"), srows.get("oil", {}).get("cum12"))
            out["water"]["n_water_analogs"] = len(water_rows)
            out["water"]["n_measured_curves"] = len(measured_water)
        months: dict[str, list[float]] = {s: [0.0] * K_MONTHS for s in SERIES_STREAMS}
        for m in session.execute(text(_MONTHS_SQL), {"r": r, "loc": row["location_id"], "k": K_MONTHS}).mappings():
            if m["stream"] in months and 1 <= m["month_no"] <= K_MONTHS:
                months[m["stream"]][m["month_no"] - 1] = float(m["volume"])
        forecast = {}
        for st in SERIES_STREAMS:
            mult = (out["chain"].get(st) or {}).get("lateral_mult")
            forecast[st] = [v / mult for v in months[st]] if mult else None
        water_curves = [c for c in (series(w["api10"], w["first_production"], w["lateral_ft"], "water") for w in measured_water) if c]
        out["chart"] = {
            "months": K_MONTHS,
            "unit": {"oil": "bbl per 1,000 ft", "gas": "mcf per 1,000 ft", "water": "bbl per 1,000 ft"},
            "forecast": forecast,
            "band": {
                "oil": band_monthly([a["actual"]["oil"] for a in analogs if a["actual"]["oil"]]),
                "gas": band_monthly([a["actual"]["gas"] for a in analogs if a["actual"]["gas"]]),
                # water's cohort is the MEASURED-water analog set (sql/62), not the oil / gas analogs
                "water": band_monthly(water_curves),
            },
            "water_curves": water_curves if len(water_curves) <= 40 else None,
        }

    out["analogs"] = analogs
    out["nearby_pdp"] = nearby
    out["neighbours"] = neighbours
    out["notes"] = cohort_notes(loc, analogs, nearby, neighbours, oil_per_ft)
    return json.loads(json.dumps(out, default=_json_default), parse_constant=lambda _: None)


def _json_default(o: Any) -> Any:
    if isinstance(o, dt.date | dt.datetime):
        return o.isoformat()
    if isinstance(o, float):
        return _clean(o)
    return str(o)
