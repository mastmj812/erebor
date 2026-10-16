"""BOX forecasts (engineering_db plan step 8): the record run, its coverage classes,
and a per-pad workup rendered on demand from box.* (D80: the database is the record;
workup pages are renders).

Read-only like the rest of erebor. BOX = defensible analog type-curve workups (D54/D57):
deal-intake analog cohort P50 per 1,000 ft x lateral (Cui & Cross below 7,500 ft, D50)
x the stated walk-forward haircut (D62); uptime-free volumes (D63; F(k) is published,
not applied); oil + gas only (D72); EUR = raw 50-yr technical integral (no economic
limit). v1 covers Delaware WCA_1 / WCA_2 inside the WCA extent (D60/D61); everything
else is a stated not-covered class, never a zero.

  GET /api/box/meta?basin=            record run + provenance + haircut / disclosure
                                       + Steven's priced decks for that run + scope
  GET /api/box/pad?basin=&pad_key=    one Highgrade pad: every PUD's coverage + BOX
                                       numbers vs Novi, named analogs, forecast vs
                                       analog actuals (oil cum per 1,000 ft)

The fragments below (box_joins / coverage_sql / econ_join) are shared with
highgrade.py so the choropleth, the gunbarrel and this workup class every PUD the
same way. Nothing here reads the retired step-4/5 tables (D66).
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(prefix="/box", tags=["box"])

_BASIN = Query(..., pattern="^(delaware|midland)$")

# Every screened PUD lands in exactly one class. The first six are box.pud_forecast's
# own coverage values (sql/60, D67); the last three are derived for a PUD with no row
# in the record run:
#   bench_not_in_box  its bench is in no box.bench_scope pool (not part of BOX v1)
#   realized          reconciliation matched it to production (shown only when the
#                     Highgrade "All Novi BASE_CASE" toggle readmits realized PUDs)
#   no_box_row        drillable, on a BOX bench, yet missing from the record run —
#                     expected 0; non-zero means the Novi vintage moved under the run
COVERAGE_CLASSES: tuple[str, ...] = (
    "covered",
    "not_covered_no_analogs",
    "not_covered_outside_extent",
    "not_covered_wcxy",
    "not_covered_unvalidated",
    "not_covered_emerging",
    "bench_not_in_box",
    "realized",
    "no_box_row",
)

STREAMS = ("oil", "gas")
HORIZONS = ("12", "24", "36", "48")
K_CHART = 48  # months of cum per 1,000 ft on the workup chart (engineering_db box/production_pages.K_CHART)


def box_joins(a: str) -> str:
    """BOX record-run joins onto a Novi PUD alias `a` (needs param :box_run).
    box.pud_forecast is UNIQUE on (run_id, stick_id) and the stream rows on
    (run_id, location_id, stream), so no join multiplies rows."""
    return (
        f"LEFT JOIN box.pud_forecast bp ON bp.run_id = :box_run AND bp.stick_id = {a}.stick_id "
        "LEFT JOIN box.pud_forecast_stream bso ON bso.run_id = bp.run_id "
        "AND bso.location_id = bp.location_id AND bso.stream = 'oil' "
        "LEFT JOIN box.pud_forecast_stream bsg ON bsg.run_id = bp.run_id "
        "AND bsg.location_id = bp.location_id AND bsg.stream = 'gas' "
        # the PUD's bench is in a BOX pool (bench_scope.member_benches; DISTINCT so a
        # bench listed in two pools could never multiply rows). Needs the `fb` join first.
        "LEFT JOIN (SELECT DISTINCT basin, unnest(member_benches) AS bench FROM box.bench_scope) bsm "
        f"ON bsm.basin = {a}.basin AND bsm.bench = fb.formation_blueox"
    )


def econ_join() -> str:
    """Steven's priced case (needs :econ_deck, :econ_aset); PK (run, location, deck,
    assumption set) -> at most one row per location. Display-only (D13)."""
    return (
        "LEFT JOIN box_econ.box_pud_econ be ON be.run_id = bp.run_id AND be.location_id = bp.location_id "
        "AND be.deck_id = :econ_deck AND be.assumption_set_id = :econ_aset"
    )


def coverage_sql(a: str) -> str:  # noqa: ARG001 — alias kept for call-site symmetry
    """Coverage class of a Novi PUD row (aliases from box_joins: `bp`, `bsm`; plus `rec`
    reconciliation). Evaluated per class in the pad counts, so it stays join-only."""
    return (
        "(CASE WHEN bp.coverage IS NOT NULL THEN bp.coverage "
        "WHEN rec.status IN ('realized_drift', 'realized_phantom') THEN 'realized' "
        "WHEN bsm.bench IS NOT NULL THEN 'no_box_row' "
        "ELSE 'bench_not_in_box' END)"
    )


def record_run(session: Session) -> dict[str, Any]:
    """The one BOX run marked is_record (sql/60 allows at most one)."""
    row = session.execute(
        text(
            "SELECT run_id, report_version, data_through, code_sha, engine_sha, dealintake_config, "
            "created_at, haircut, calendar_factor, disclosure, counts, notes "
            "FROM box.forecast_run WHERE is_record"
        )
    ).mappings().first()
    if row is None:
        raise HTTPException(503, "no BOX forecast run is marked as the record")
    r = dict(row)
    r["data_through"] = r["data_through"].isoformat()
    r["created_at"] = r["created_at"].isoformat()
    return r


def disclosure_rows(run: dict[str, Any]) -> list[dict[str, Any]]:
    """D59 condition 3: measured hindcast bias, the haircut and the held-out bias after
    correction, per stream x horizon (error = actual / forecast - 1). `haircut` is the D62
    factor (the target); runs built with the D92 shape also carry the REALISED cumulative
    factor across covered PUDs (median, P10 high / P90 low) — what the volumes actually
    carry. None on runs before D92 (4, 6), where realised = target exactly."""
    hb = run["disclosure"]["hindcast_bias"]
    out = []
    for s in STREAMS:
        for k in HORIZONS:
            b, h = hb[s][k], run["haircut"][s][k]
            out.append({
                "stream": s, "horizon": f"cum-{k}",
                "measured_bias": b["box_v2_pooled_bias"], "packages": b["box_v2_pooled_packages"],
                "haircut": h["factor"], "holdout_bias_after": b["box_v2_wf_holdout_bias"],
                "holdout_packages": b["box_v2_wf_holdout_packages"],
                "realised_median": h.get("realised_median"),
                "realised_p10": (h.get("realised_p10_p90") or [None, None])[0],
                "realised_p90": (h.get("realised_p10_p90") or [None, None])[1],
            })
    return out


def haircut_method(run: dict[str, Any]) -> dict[str, Any]:
    """How the run applied its haircut: D92 (smooth rate factor fitted to the D62 targets,
    rate factor held after month 48 — `tail` = its median per stream) or D62 as built
    (method None: linear cumulative factor, cum-48 factor held)."""
    h = run["haircut"]
    if "method" not in h:
        return {"method": None, "tail": None, "eur_factor": None}
    return {"method": h["method"],
            "tail": {s: h[s].get("tail_factor_median") for s in STREAMS},
            "eur_factor": {s: h[s].get("eur_factor_median") for s in STREAMS}}


def radius_ranges(run: dict[str, Any], classes: set[str] | None = None) -> list[dict[str, Any]]:
    """D69: measured package range (80 % of held-out packages) per analog-radius class."""
    out = []
    for key, v in run["disclosure"]["radius_ranges"].items():
        rc, hz = key.split("|")
        if classes is None or rc in classes:
            out.append({"radius_class": rc, "horizon": hz, "low": v["p90_low"], "high": v["p10_high"],
                        "bias": v["bias"], "packages": v["packages"]})
    return out


def calendar_factor_points(run: dict[str, Any]) -> dict[str, dict[str, float]]:
    """F(k) at the reporting horizons (published alongside, NOT applied — D63)."""
    out: dict[str, dict[str, float]] = {}
    for s in STREAMS:
        f = run["calendar_factor"][s]["F"]
        out[s] = {str(k): float(f[k - 1]) for k in (12, 24, 36, 48) if k <= len(f)}
    return out


@router.get("/meta")
def meta(basin: str = _BASIN, session: Session = Depends(get_session)) -> dict:
    run = record_run(session)
    decks = session.execute(
        text(
            "SELECT deck_id, assumption_set_id, downtime_basis, count(*) AS n_priced, "
            "min(wti) AS wti, min(hh) AS hh, max(built_at) AS built_at, "
            "count(*) FILTER (WHERE unpriced_reason IS NOT NULL) AS n_unpriced "
            "FROM box_econ.box_pud_econ WHERE run_id = :r "
            "GROUP BY deck_id, assumption_set_id, downtime_basis ORDER BY deck_id, assumption_set_id"
        ),
        {"r": run["run_id"]},
    ).mappings().all()
    vintages = session.execute(
        text("SELECT DISTINCT report_version FROM curated.intel_locations WHERE basin = :b ORDER BY 1"),
        {"b": basin},
    ).scalars().all()
    scope = session.execute(
        text("SELECT bench, in_scope, member_benches, reason FROM box.bench_scope WHERE basin = :b ORDER BY bench"),
        {"b": basin},
    ).mappings().all()
    return {
        "basin": basin,
        "run": {k: run[k] for k in ("run_id", "report_version", "data_through", "code_sha", "engine_sha",
                                    "dealintake_config", "created_at", "counts", "notes")},
        "disclosure": disclosure_rows(run),
        "haircut_method": haircut_method(run),
        "radius_ranges": radius_ranges(run),
        "calendar_factor": calendar_factor_points(run),
        "decks": [{**d, "built_at": d["built_at"].isoformat() if d["built_at"] else None} for d in decks],
        "intel_report_versions": list(vintages),
        # the record run keys on its own vintage's stick ids; a newer Novi vintage in the
        # warehouse means BOX coverage reads as no_box_row until the quarterly BOX refresh
        "stale": run["report_version"] not in vintages,
        "scope": [dict(s) for s in scope],
    }


# ---------------------------------------------------------------------------
# one well (Map-tab production overlay)
# ---------------------------------------------------------------------------
DAYS_PER_MONTH = 365.25 / 12


def monthly_series(months: list[int], volumes: list[float]) -> dict[str, list[float]]:
    """Exact monthly volumes (D39) -> a rate series at mid-month (volume / days, uptime-free
    so NOT a calendar rate) and a cumulative series at month end. Months absent from the
    rows count as zero."""
    n = max(months, default=0)
    vol = np.zeros(n)
    for m, v in zip(months, volumes, strict=True):
        vol[m - 1] = v
    k = np.arange(1, n + 1)
    return {
        "rate_day": [float(d) for d in (k - 0.5) * DAYS_PER_MONTH],
        "rate": [float(v) for v in vol / DAYS_PER_MONTH],
        "cum_day": [float(d) for d in k * DAYS_PER_MONTH],
        "cum": [float(v) for v in np.cumsum(vol)],
    }


def well_forecast(session: Session, basin: str, unique_id: str) -> dict[str, Any] | None:
    """The record run's BOX forecast for one Novi PUD (by its Novi name). None when the name
    is not a Novi PUD (PDP / RES); otherwise its coverage class, and for a covered PUD the
    oil + gas monthly series (no water in v1, D72)."""
    run = record_run(session)
    row = session.execute(
        text(f"""
            SELECT il.stick_id, {coverage_sql('il')} AS coverage, bp.location_id, bp.lateral_ft,
                   bso.eur AS oil_eur, bso.eur_per_kft AS oil_eur_per_kft,
                   bsg.eur AS gas_eur, bsg.eur_per_kft AS gas_eur_per_kft
            FROM curated.intel_locations il
            LEFT JOIN curated.intel_formation_blueox fb ON fb.stick_id = il.stick_id
            LEFT JOIN curated.reconciled_inventory rec ON rec.stick_id = il.stick_id
            {box_joins('il')}
            WHERE il.basin = :basin AND il.unique_id = :name AND il.category = 'PUD'
            ORDER BY il.stick_id LIMIT 1
        """),
        {"basin": basin, "name": unique_id, "box_run": run["run_id"]},
    ).mappings().first()
    if row is None:
        return None
    out: dict[str, Any] = {
        "run_id": run["run_id"], "data_through": run["data_through"],
        "coverage": row["coverage"], "stick_id": row["stick_id"],
        "lateral_ft": row["lateral_ft"],
        "eur": {"oil": row["oil_eur"], "gas": row["gas_eur"]},
        "eur_per_kft": {"oil": row["oil_eur_per_kft"], "gas": row["gas_eur_per_kft"]},
        "streams": {},
    }
    if row["coverage"] != "covered":
        return out
    mrows = session.execute(
        text("""
            SELECT stream, month_no, volume FROM box.pud_forecast_month
            WHERE run_id = :r AND location_id = :loc ORDER BY stream, month_no
        """),
        {"r": run["run_id"], "loc": row["location_id"]},
    ).mappings().all()
    for s in STREAMS:
        rs = [m for m in mrows if m["stream"] == s]
        if rs:
            out["streams"][s] = monthly_series([m["month_no"] for m in rs], [m["volume"] for m in rs])
    return out


# ---------------------------------------------------------------------------
# per-pad workup
# ---------------------------------------------------------------------------
def months_between(first: dt.date, d: dt.date) -> int:
    """1-based month on production of calendar month `d` for a well first producing in
    `first` (calendar months, so idle months count — calendar actuals, D63)."""
    return (d.year - first.year) * 12 + (d.month - first.month) + 1


def actual_cum_per_kft(rows: list[dict[str, Any]], first: dt.date, lateral_ft: float,
                       data_through: dt.date, k: int = K_CHART) -> np.ndarray:
    """One analog's calendar cumulative oil per 1,000 ft for months 1..k. A month with no
    report before data_through counts as zero production; months after data_through
    are NaN (not yet observed)."""
    vol = np.zeros(k)
    for r in rows:
        m = months_between(first, r["prod_date"])
        if 1 <= m <= k:
            vol[m - 1] += float(r["oil"] or 0.0)
    cum = np.cumsum(vol) / (lateral_ft / 1000.0)
    seen = min(k, max(0, months_between(first, data_through)))
    cum[seen:] = np.nan
    return cum


def band(curves: list[np.ndarray], min_n: int = 3) -> dict[str, list[float | None]] | None:
    """P10 (HIGH) / P50 / P90 (LOW) of the analog curves per month (SPE convention: P10 =
    the 90th percentile value); months with fewer than min_n analogs reporting are None."""
    if len(curves) < min_n:
        return None
    A = np.vstack(curves)
    n = np.isfinite(A).sum(axis=0)
    with np.errstate(all="ignore"):
        hi, mid, lo = (np.nanpercentile(A, q, axis=0) for q in (90, 50, 10))

    def clean(x: np.ndarray) -> list[float | None]:
        return [float(v) if c >= min_n and np.isfinite(v) else None for v, c in zip(x, n, strict=True)]

    return {"p10": clean(hi), "p50": clean(mid), "p90": clean(lo), "n": [int(c) for c in n]}


@router.get("/pad")
def pad(basin: str = _BASIN, pad_key: str = Query(...), session: Session = Depends(get_session)) -> dict:
    run = record_run(session)
    p = {"basin": basin, "pad_key": pad_key, "box_run": run["run_id"]}
    locs = session.execute(
        text(f"""
            SELECT il.stick_id, il.unique_id, COALESCE(fb.formation_blueox, '(unmapped)') AS formation_blueox,
                   il.ll_ft, il.oil_eur AS novi_oil_eur, il.gas_eur AS novi_gas_eur, rec.status AS recon_status,
                   {coverage_sql('il')} AS coverage,
                   bp.location_id, bp.lateral_ft, bp.completed_lateral_ft, bp.planned_spacing_ft,
                   bp.spacing_source, bp.search_mode, bp.radius_mi, bp.radius_class, bp.n_analogs, bp.flags,
                   bso.eur AS oil_eur, bso.eur_raw AS oil_eur_raw, bso.eur_haircut AS oil_haircut,
                   bso.eur_per_kft AS oil_eur_per_kft, bso.cum12 AS oil_cum12, bso.cum24 AS oil_cum24,
                   bso.params AS oil_params,
                   bsg.eur AS gas_eur, bsg.eur_per_kft AS gas_eur_per_kft, bsg.params AS gas_params
            FROM curated.intel_locations il
            JOIN curated.intel_pad_member pm ON pm.stick_id = il.stick_id AND pm.pad_key = :pad_key
            LEFT JOIN curated.intel_formation_blueox fb ON fb.stick_id = il.stick_id
            LEFT JOIN curated.reconciled_inventory rec ON rec.stick_id = il.stick_id
            {box_joins('il')}
            WHERE il.basin = :basin AND il.category = 'PUD'
            ORDER BY formation_blueox, il.stick_id
        """),
        p,
    ).mappings().all()
    locations = []
    for r in locs:
        d = dict(r)
        for s in STREAMS:
            prm = d.pop(f"{s}_params")
            d[f"{s}_di_nominal"] = prm.get("Di_nominal") if prm else None
            d[f"{s}_di_eff_1yr"] = prm.get("Di_eff_1yr") if prm else None
            d[f"{s}_b"] = prm.get("b") if prm else None
        d["novi_oil_eur_per_kft"] = (d["novi_oil_eur"] * 1000.0 / d["ll_ft"]
                                     if d["novi_oil_eur"] is not None and d["ll_ft"] else None)
        locations.append(d)

    covered = [d for d in locations if d["coverage"] == "covered" and d["oil_eur"] is not None]
    out: dict[str, Any] = {
        "basin": basin, "pad_key": pad_key,
        "run": {k: run[k] for k in ("run_id", "report_version", "data_through", "code_sha", "engine_sha",
                                    "dealintake_config", "created_at")},
        "locations": locations, "analogs": [], "chart": None,
        "disclosure": disclosure_rows(run),
        "haircut_method": haircut_method(run),
        "radius_ranges": radius_ranges(run, {d["radius_class"] for d in covered if d["radius_class"]}),
        "calendar_factor": calendar_factor_points(run),
    }
    if not covered:
        return out

    ids = [d["location_id"] for d in covered]
    an = session.execute(
        text("""
            SELECT la.api10, min(la.dist_ft) AS nearest_ft, count(*) AS used_by,
                   max(la.lateral_ft) AS lateral_ft, min(la.first_production) AS first_production,
                   bool_or(la.transfer) AS transfer, max(w.well_name) AS well_name,
                   max(w.current_operator) AS operator
            FROM box.location_analog la
            LEFT JOIN curated.wells w ON w.api10 = la.api10
            WHERE la.run_id = :r AND la.location_id IN :ids
            GROUP BY la.api10 ORDER BY nearest_ft
        """).bindparams(bindparam("ids", expanding=True)),
        {"r": run["run_id"], "ids": ids},
    ).mappings().all()
    out["analogs"] = [{**a, "first_production": a["first_production"].isoformat() if a["first_production"] else None}
                      for a in an]

    # forecast: each covered location's cumulative oil per 1,000 ft (P50 x haircut,
    # uptime-free) from the exact monthly rows (D39)
    mrows = session.execute(
        text("""
            SELECT location_id, month_no, volume FROM box.pud_forecast_month
            WHERE run_id = :r AND stream = 'oil' AND location_id IN :ids AND month_no <= :k
            ORDER BY location_id, month_no
        """).bindparams(bindparam("ids", expanding=True)),
        {"r": run["run_id"], "ids": ids, "k": K_CHART},
    ).mappings().all()
    lat = {d["location_id"]: d["lateral_ft"] for d in covered}
    vols: dict[int, np.ndarray] = {i: np.zeros(K_CHART) for i in ids}
    for m in mrows:
        vols[m["location_id"]][m["month_no"] - 1] = m["volume"]
    forecast = [{"location_id": i, "stick_id": next(d["stick_id"] for d in covered if d["location_id"] == i),
                 "cum_per_kft": [float(v) for v in np.cumsum(vols[i]) / (lat[i] / 1000.0)]} for i in ids]

    # analog actuals: calendar cumulative oil per 1,000 ft (carries downtime; the
    # forecast does not — D63), anchored on each analog's first production month
    usable = [a for a in an if a["first_production"] and a["lateral_ft"]]
    data_through = dt.date.fromisoformat(run["data_through"])
    curves: list[np.ndarray] = []
    if usable:
        prod = session.execute(
            text("""
                SELECT api10, prod_date, oil_per_month_bbl AS oil FROM curated.production
                WHERE api10 IN :api AND prod_date <= :thru
            """).bindparams(bindparam("api", expanding=True)),
            {"api": [a["api10"] for a in usable], "thru": data_through},
        ).mappings().all()
        by: dict[str, list[dict[str, Any]]] = {}
        for r in prod:
            by.setdefault(r["api10"], []).append(dict(r))
        for a in usable:
            if a["api10"] in by:
                curves.append(actual_cum_per_kft(by[a["api10"]], a["first_production"], a["lateral_ft"], data_through))
    out["chart"] = {"months": K_CHART, "unit": "bbl oil per 1,000 ft (cumulative)",
                    "forecast": forecast, "analog_band": band(curves), "n_analog_curves": len(curves)}
    return out
