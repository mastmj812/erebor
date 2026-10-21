"""Highgrade tab: screen the basin's remaining stick locations for target pads, on BOX.

The inverse of /select's AOI rollup. The user filters the remaining locations by bench,
BOX value ranges, Steven's econ ranges and the PDP-proximity outcome, aggregates ONE
metric per pad (Novi's 2026Q3 DSU polygons, curated.intel_pad_geom v3), and the pads are
colored low -> high so the best units matching the screen stand out.

Overhaul step 5 (docs/overhaul_plan.md): BOX-only. Novi supplies the stick geometry and
the pad polygons, nothing else (Michael, 2026-10-21) — no Novi tag (PUD / RES, tiers),
no Novi forecast, no Novi NPV is read here.

  * Population = every Novi stick location in the basin (curated.erebor_locations,
    category <> 'PDP' — Novi's PUD / RES split is not used) that OUR reconciliation did
    not match to production (recon_status realized_drift / realized_phantom drop out;
    sql/68 reconciles every stick, D117).
  * Values = the BOX record run (box.forecast_run.is_record) through app.box_locations:
    analog-workup EUR (D57/D62, uptime-free, raw 50-yr technical integral, the D113
    proximity factor already inside the stored oil EUR; water since sql/62). Every
    location gets a coverage class (box_locations.map_coverage_sql); aggregates use
    FORECAST-CARRYING rows only (covered = validated + covered_provisional, D105), with
    the validated / provisional valued counts reported apart and the not-covered count
    reported per class — a not-covered location is never a zero (D2/D67).
  * Econ = Steven's box_econ.box_pud_econ for the RECORD run and ONE deck (default
    WTI 70 / HH 3; the assumption set is resolved server-side) — a display-only screen
    with provenance (D13: nothing here computes economics). PV / capex aggregate as
    sum | avg | per acre; IRR and breakeven as the per-pad MEDIAN (a sum or mean of
    IRRs is meaningless). Unpriced = counted, never zeroed.

Two endpoints:
  GET  /api/highgrade/facets?basin=&deck=  -> bench list + numeric min/max for the range UI
  POST /api/highgrade/pads                 -> per-pad FeatureCollection + value range
plus the per-DSU gunbarrel (POST /api/highgrade/gunbarrel).
"""

from __future__ import annotations

import json
import math
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.box_locations import (
    ECON_METRICS, EUR_STREAMS, FORECAST_IN_SQL, MAP_COVERAGE_CLASSES, PROX_GROUPS, box_joins, econ_case, econ_join,
    econ_provenance, kind_sql, map_coverage_sql, record_run,
)
from app.db import get_session

router = APIRouter(prefix="/highgrade", tags=["highgrade"])

_BASIN = Query(..., pattern="^(delaware|midland)$")

# Local planar approximation for the single-pad gunbarrel projection (see below).
M_PER_DEG_LAT = 110540.0
M_PER_DEG_LON = 111320.0
FT_PER_M = 3.28084


def _canonical_axis(perp: tuple[float, float]) -> tuple[tuple[float, float], str, str]:
    """Canonicalize the cross-section axis to the suite-wide gunbarrel reading
    (same rule as anduin's dossier/inspect charts and narvi's panel): a ~N-S
    lateral set (axis runs E-W) reads W -> E, a ~E-W set (axis runs N-S) reads
    S -> N (sign rule v2, Michael 2026-10-08: + points into the NE half; a
    perfect 45° tie goes to the E-W branch). The mean heel->toe direction is
    data-order arbitrary, so the
    DOMINANT compass component of the perpendicular decides and the sign flips
    to match. Copy-shared with gunbarrel.py / accuracy.py (like the projection
    constants). Returns (axis, left_label, right_label)."""
    px, py = perp  # (east, north) components
    if abs(px) >= abs(py):  # axis runs E-W: +offset = East
        return ((-px, -py) if px < 0 else (px, py)), "W", "E"
    return ((-px, -py) if py < 0 else (px, py)), "S", "N"  # +offset = North


# ---------------------------------------------------------------------------
# population, metrics, whitelists
# ---------------------------------------------------------------------------
# `el` aliases curated.erebor_locations in every query below. PDP rows are producing
# context (rule 8), never screened; realized = OUR reconciliation (sql/20 + sql/68).
POPULATION = (
    "el.basin = :basin AND el.category <> 'PDP' "
    "AND el.recon_status IS DISTINCT FROM 'realized_drift' "
    "AND el.recon_status IS DISTINCT FROM 'realized_phantom'"
)
# The screened population's coverage classes: realized never reaches the screen.
HG_COVERAGE_CLASSES: tuple[str, ...] = tuple(c for c in MAP_COVERAGE_CLASSES if c != "realized")
_TIERS = {"validated": "covered", "provisional": "covered_provisional"}

EUR_METRICS: tuple[str, ...] = (
    *(f"{s}_eur" for s in EUR_STREAMS), *(f"{s}_eur_per_kft" for s in EUR_STREAMS),
)
# Steven's columns split by how a pad aggregates them: $ amounts add up; IRR and the
# breakeven are rates, so a pad shows the median of its priced locations.
ECON_SUMMABLE: tuple[str, ...] = tuple(k for k, m in ECON_METRICS.items() if m["unit"] == "$MM")
ECON_MEDIAN: tuple[str, ...] = tuple(k for k in ECON_METRICS if k not in ECON_SUMMABLE)
METRICS: tuple[str, ...] = (*EUR_METRICS, *ECON_METRICS, "well_count")
Metric = Literal[
    "oil_eur", "gas_eur", "water_eur", "oil_eur_per_kft", "gas_eur_per_kft", "water_eur_per_kft",
    "pv0", "pv10", "pv15", "pv20", "pv25", "pv30", "irr", "be_wti", "capex",
    "well_count",
]
Agg = Literal["sum", "avg", "per_acre"]

# Range filters -> SQL ref. BOX bounds (stored units: bbl / mcf, per 1,000 ft, the D113
# oil factor, the lateral BOX used) bound FORECAST locations only: a location without a
# BOX forecast stays in the screen, counted under its class, never dropped by a BOX bound
# (dropping it would hide the not-covered count, D67).
BOX_RANGES: dict[str, str] = {
    **{f"{s}_eur": f"bs{s[0]}.eur" for s in EUR_STREAMS},
    **{f"{s}_eur_per_kft": f"bs{s[0]}.eur_per_kft" for s in EUR_STREAMS},
    "prox_factor": "bso.prox_factor",  # D113: 1 = as-is; 0.75-0.94 = multi-parent haircut
    "lateral_ft": "bp.lateral_ft",
}
# Econ bounds, Steven's units ($MM, %, $/bbl). Same keep rule for not-covered locations;
# a forecast location with no priced value fails the bound (it cannot be shown to pass).
ECON_RANGES: dict[str, str] = {f"econ_{k}": f"be.{m['col']}" for k, m in ECON_METRICS.items()}


def is_money(metric: str) -> bool:
    return metric in ECON_SUMMABLE


def _kft(t: str) -> str:
    """The lateral (kft) BOX's stored eur_per_kft used, recovered as eur / eur_per_kft, so
    a one-location pad reproduces the stored per-row value exactly."""
    return f"({t}.eur / NULLIF({t}.eur_per_kft, 0))"


def _stream_alias(metric: str) -> str:
    return "bs" + metric[0]  # oil -> bso, gas -> bsg, water -> bsw (box_joins aliases)


def row_value_sql(metric: str) -> str:
    """Per-location SQL value of a metric. NULL where BOX has no value — every
    not-covered location, and for econ every unpriced one. Money in $ (Steven's $MM
    x 1e6), IRR in %, breakeven in $/bbl WTI. Raises ValueError on an unknown metric
    (the endpoints validate first, so this is a programming guard)."""
    if metric not in METRICS:
        raise ValueError(f"unknown Highgrade metric {metric!r}")
    if metric == "well_count":
        return "NULL::double precision"
    if metric in ECON_METRICS:
        col = f"be.{ECON_METRICS[metric]['col']}"
        return f"({col} * 1e6)" if is_money(metric) else col
    t = _stream_alias(metric)
    if metric.endswith("_per_kft"):
        return f"({t}.eur / NULLIF({_kft(t)}, 0))"
    return f"{t}.eur"


def resolve_agg(metric: str, agg: str) -> str:
    """The aggregation actually applied: count / lateral-weighted / median are fixed by
    the metric; per acre only for $ amounts (else a plain sum)."""
    if metric == "well_count":
        return "count"
    if metric.endswith("_per_kft"):
        return "lateral_weighted"
    if metric in ECON_MEDIAN:
        return "median"
    if agg == "per_acre" and not is_money(metric):
        return "sum"
    return agg


def value_expr(metric: str, agg: str) -> str:
    """Per-pad aggregate. Rows whose value is NULL (not covered; unpriced) drop out of
    sum / avg / median by SQL semantics and are counted separately (n_valued), never read
    as zero. Per-1,000-ft = the pad's lateral-weighted ratio sum(EUR) / sum(kft) over
    locations carrying both. per_acre's numerator is the per-pad sum; the /acre division
    happens where the pad geometry is joined."""
    a = resolve_agg(metric, agg)
    if a == "count":
        return "count(*)"
    if a == "lateral_weighted":
        t = _stream_alias(metric)
        both = f"{t}.eur IS NOT NULL AND {_kft(t)} > 0"
        return f"(sum({t}.eur) FILTER (WHERE {both}) / NULLIF(sum({_kft(t)}) FILTER (WHERE {both}), 0))"
    v = row_value_sql(metric)
    if a == "median":
        return f"percentile_cont(0.5) WITHIN GROUP (ORDER BY {v})"
    return f"{'avg' if a == 'avg' else 'sum'}({v})"


def n_valued_expr(metric: str, coverage: str | None = None) -> str:
    """Locations contributing to the pad value (well_count: every screened location).
    With `coverage`, only that tier's: the validated / provisional split (D105)."""
    tier = f"bp.coverage = '{coverage}'" if coverage else None
    if metric == "well_count":
        return f"count(*) FILTER (WHERE {tier})" if tier else "count(*)"
    if metric.endswith("_per_kft"):
        t = _stream_alias(metric)
        return f"count(*) FILTER (WHERE {t}.eur IS NOT NULL AND {_kft(t)} > 0{' AND ' + tier if tier else ''})"
    v = f"count({row_value_sql(metric)})"
    return f"{v} FILTER (WHERE {tier})" if tier else v


def _in_list(values: tuple[str, ...]) -> str:
    """SQL IN-list of whitelisted constants (box_locations.PROX_GROUPS — never user input)."""
    return "(" + ", ".join(f"'{v}'" for v in values) + ")"


# ---------------------------------------------------------------------------
# filters
# ---------------------------------------------------------------------------
class HighgradeFilters(BaseModel):
    # bench multi-select by formation_blueox (omit / empty -> every bench)
    formation_blueox: list[str] | None = None
    # PDP-proximity outcome groups (box_locations.PROX_GROUPS)
    prox: list[Literal["as_is", "haircut", "no_precedent"]] | None = None
    # numeric ranges keyed by a whitelisted BOX_RANGES / ECON_RANGES key -> [min, max]
    ranges: dict[str, tuple[float | None, float | None]] = Field(default_factory=dict)


def has_econ_range(filters: HighgradeFilters) -> bool:
    return any(k in ECON_RANGES and (lo is not None or hi is not None) for k, (lo, hi) in (filters.ranges or {}).items())


def build_filters(filters: HighgradeFilters, econ: bool) -> tuple[list[str], dict, list]:
    """(where_fragments, params, expanding_bindparams) from validated filters. Econ
    bounds apply only when the econ join is present (`econ` = the record run is priced)."""
    clauses: list[str] = []
    params: dict = {}
    expanding: list = []

    if filters.formation_blueox:
        clauses.append("COALESCE(el.formation_blueox, '(unmapped)') IN :formation_blueox")
        params["formation_blueox"] = list(filters.formation_blueox)
        expanding.append(bindparam("formation_blueox", expanding=True))

    keep = f"bp.coverage IS NULL OR bp.coverage NOT IN {FORECAST_IN_SQL} OR "
    for col, bounds in (filters.ranges or {}).items():
        ref = BOX_RANGES.get(col) or (ECON_RANGES.get(col) if econ else None)
        if ref is None:
            continue  # unknown (or econ without a priced run): ignored, never trusted
        lo, hi = bounds
        if lo is not None:
            clauses.append(f"({keep}{ref} >= :{col}_lo)")
            params[f"{col}_lo"] = lo
        if hi is not None:
            clauses.append(f"({keep}{ref} <= :{col}_hi)")
            params[f"{col}_hi"] = hi

    # PDP-proximity outcome: an explicit categorical screen, so it DOES drop locations
    # outside the selection — including those BOX never measured (no bpp row)
    if filters.prox:
        clauses.append("bpp.outcome IN :prox")
        params["prox"] = [o for g in filters.prox for o in PROX_GROUPS[g]]
        expanding.append(bindparam("prox", expanding=True))

    return clauses, params, expanding


def _box_from(econ: bool) -> str:
    """FROM clause shared by facets / pads: the location population + the BOX joins."""
    return (
        "FROM curated.erebor_locations el "
        f"{box_joins('el', bench='el.formation_blueox')} "
        f"{econ_join() if econ else ''}"
    )


def _econ_params(case: dict[str, Any] | None) -> dict[str, Any]:
    return {} if case is None else {"econ_deck": case["deck_id"], "econ_aset": case["assumption_set_id"]}


# ---------------------------------------------------------------------------
# facets
# ---------------------------------------------------------------------------
def facets_sql(econ: bool) -> str:
    """Bench list over the screened population + min/max of every range, taken over
    forecast locations (BOX) / priced ones (econ) — the rows a bound can act on."""
    num = [f"min({ref}) AS {c}_min, max({ref}) AS {c}_max" for c, ref in BOX_RANGES.items()]
    if econ:
        num += [f"min({ref}) AS {c}_min, max({ref}) AS {c}_max" for c, ref in ECON_RANGES.items()]
    return (
        "SELECT array_agg(DISTINCT COALESCE(el.formation_blueox, '(unmapped)')) AS formation_blueox, "
        + ", ".join(num) + " "
        + _box_from(econ) + f" WHERE {POPULATION}"
    )


@router.get("/facets")
def facets(
    basin: str = _BASIN,
    deck: str | None = Query(None, max_length=64),
    session: Session = Depends(get_session),
) -> dict:
    run = record_run(session)
    case = econ_case(session, run["run_id"], deck)
    row = session.execute(
        text(facets_sql(case is not None)),
        {"basin": basin, "box_run": run["run_id"], **_econ_params(case)},
    ).mappings().one()
    cols = [*BOX_RANGES, *(ECON_RANGES if case is not None else ())]
    return {
        "basin": basin,
        "categorical": {"formation_blueox": sorted(row["formation_blueox"] or [])},
        "numeric": {c: {"min": row[f"{c}_min"], "max": row[f"{c}_max"]} for c in cols},
        "econ_priced": case is not None,
    }


# ---------------------------------------------------------------------------
# pads (filtered per-pad aggregation -> choropleth)
# ---------------------------------------------------------------------------
class PadsBody(BaseModel):
    basin: Literal["delaware", "midland"]
    filters: HighgradeFilters = Field(default_factory=HighgradeFilters)
    metric: Metric = "oil_eur_per_kft"
    agg: Agg = "sum"
    deck: str | None = Field(None, max_length=64)  # Steven's deck id; None = default (WTI 70 / HH 3)


def check_metric(metric: str, priced: bool) -> None:
    if metric in ECON_METRICS and not priced:
        raise HTTPException(422, "econ metrics need a priced record run (Steven has not priced it yet)")


def pads_sql(metric: str, agg: str, filt_sql: str, econ: bool) -> str:
    v_expr = value_expr(metric, agg)
    n_valued = n_valued_expr(metric)
    final_value = "a.value / NULLIF(p.acres, 0)" if resolve_agg(metric, agg) == "per_acre" else "a.value"
    cov = map_coverage_sql("el")
    # one count per coverage class per pad + the valued wells per tier (D105: the pad
    # value carries both tiers, so its make-up is reported, never folded into one count)
    cov_cols = "".join(f", count(*) FILTER (WHERE {cov} = '{c}') AS nc_{c}" for c in HG_COVERAGE_CLASSES)
    cov_cols += "".join(f", {n_valued_expr(metric, coverage=c)} AS nv_{t}" for t, c in _TIERS.items())
    # PDP-proximity outcome counts per pad + the haircut factor range on the pad
    cov_cols += "".join(f", count(*) FILTER (WHERE bpp.outcome IN {_in_list(o)}) AS np_{g}" for g, o in PROX_GROUPS.items())
    cov_cols += (", min(bpp.factor) FILTER (WHERE bpp.outcome = 'haircut') AS prox_min"
                 ", max(bpp.factor) FILTER (WHERE bpp.outcome = 'haircut') AS prox_max")
    extra = [*(f"nc_{c}" for c in HG_COVERAGE_CLASSES), *(f"nv_{t}" for t in _TIERS),
             *(f"np_{g}" for g in PROX_GROUPS), "prox_min", "prox_max"]
    sel = "".join(f", a.{x}" for x in extra)
    props = "".join(f", '{x}', {x}" for x in extra)
    summary = (
        ", 'coverage_counts', (SELECT json_build_object("
        + ", ".join(f"'{c}', COALESCE(sum(nc_{c}), 0)" for c in HG_COVERAGE_CLASSES) + ") FROM agg)"
        + ", 'valued_by_tier', (SELECT json_build_object("
        + ", ".join(f"'{t}', COALESCE(sum(nv_{t}), 0)" for t in _TIERS) + ") FROM agg)"
        + ", 'proximity_counts', (SELECT json_build_object("
        + ", ".join(f"'{g}', COALESCE(sum(np_{g}), 0)" for g in PROX_GROUPS)
        + ", 'factor_min', min(prox_min), 'factor_max', max(prox_max)) FROM agg)"
    )
    return f"""
        WITH agg AS (
            -- per SPATIAL pad (pad_key, sql/67): Novi's DSU polygon when the stick lies in
            -- its named polygon, else a [k/n] stick-hull split of a reused name. A stick
            -- with no pad_name / geometry has no member row -> pad_key NULL -> wells_without_pad.
            SELECT pm.pad_key,
                   {v_expr}   AS value,
                   {n_valued} AS n_valued,
                   count(*)   AS n_wells
                   {cov_cols}
            {_box_from(econ)}
            LEFT JOIN curated.intel_pad_member pm ON pm.stick_id = el.stick_id
            WHERE {POPULATION} {filt_sql}
            GROUP BY pm.pad_key
        ),
        joined AS (
            SELECT a.pad_key, p.pad_name, p.n_parts, p.geom_source, {final_value} AS value,
                   a.n_valued, a.n_wells, p.acres, p.geom {sel}
            FROM agg a
            LEFT JOIN curated.intel_pad_geom p ON p.basin = :basin AND p.pad_key = a.pad_key
            WHERE a.pad_key IS NOT NULL
        )
        SELECT json_build_object(
            'pad_count',         count(*) FILTER (WHERE geom IS NOT NULL),
            'pads_missing_geom', count(*) FILTER (WHERE geom IS NULL),
            -- Novi pad names drawn as >1 polygon (same-name strays, sql/67)
            'names_split',       count(DISTINCT pad_name) FILTER (WHERE n_parts > 1),
            'pads_hull',         count(*) FILTER (WHERE geom IS NOT NULL AND geom_source = 'stick_hull_330ft'),
            'well_count',        COALESCE(sum(n_wells), 0),
            -- locations carrying a value (BOX forecast; econ: priced) — the rest are
            -- reported, never summed as zero
            'valued_count',      COALESCE(sum(n_valued), 0),
            'pads_unvalued',     count(*) FILTER (WHERE geom IS NOT NULL AND n_valued = 0)
            {summary},
            'wells_without_pad', COALESCE((SELECT n_wells FROM agg WHERE pad_key IS NULL), 0),
            'value_min',         min(value) FILTER (WHERE geom IS NOT NULL),
            'value_max',         max(value) FILTER (WHERE geom IS NOT NULL),
            'pads', json_build_object(
                'type', 'FeatureCollection',
                'features', COALESCE(json_agg(
                    json_build_object(
                        'type', 'Feature',
                        'geometry', ST_AsGeoJSON(geom)::json,
                        'properties', json_build_object(
                            'pad_key', pad_key, 'pad_name', pad_name, 'n_parts', n_parts,
                            'geom_source', geom_source,
                            'value', value, 'n_valued', n_valued, 'n_wells', n_wells,
                            'acres', round(acres::numeric, 1) {props}
                        )
                    )) FILTER (WHERE geom IS NOT NULL), '[]'::json)
            )
        )::text
        FROM joined
    """


def _run_out(run: dict[str, Any]) -> dict[str, Any]:
    return {k: run[k] for k in ("run_id", "report_version", "data_through", "code_sha")}


@router.post("/pads")
def pads(body: PadsBody, session: Session = Depends(get_session)) -> dict:
    run = record_run(session)
    case = econ_case(session, run["run_id"], body.deck)
    check_metric(body.metric, case is not None)
    # the econ join only when something reads it (an econ metric or an econ bound)
    econ = case is not None and (body.metric in ECON_METRICS or has_econ_range(body.filters))
    where, params, expanding = build_filters(body.filters, econ)
    params |= {"basin": body.basin, "box_run": run["run_id"], **(_econ_params(case) if econ else {})}
    filt_sql = ("AND " + " AND ".join(where)) if where else ""

    sql = text(pads_sql(body.metric, body.agg, filt_sql, econ))
    if expanding:
        sql = sql.bindparams(*expanding)
    result = json.loads(session.execute(sql, params).scalar())
    return {
        "basin": body.basin, "metric": body.metric, "agg": resolve_agg(body.metric, body.agg),
        **result,
        "box_run": _run_out(run),
        # provenance of the econ case actually joined (D13); None = no econ in this screen
        "econ": econ_provenance(session, run["run_id"], case) if econ else None,
        "econ_priced": case is not None,
    }


# ---------------------------------------------------------------------------
# gunbarrel (per-DSU cross-section)
# ---------------------------------------------------------------------------
class GunbarrelBody(BaseModel):
    basin: Literal["delaware", "midland"]
    pad_key: str  # curated.intel_pad_geom (basin, pad_key) — sql/67
    filters: HighgradeFilters = Field(default_factory=HighgradeFilters)
    metric: Metric = "oil_eur_per_kft"
    deck: str | None = Field(None, max_length=64)


def gb_columns(metric_expr: str, in_filter: str, box: bool) -> list[str]:
    """Select list shared by both gunbarrel arms (UNION ALL: same columns, same order).
    The PDP arm carries NULL BOX values — producing context, never forecast (rule 8)."""
    eur_ft = (f"round((bs{s[0]}.eur_per_kft / 1000.0)::numeric, 1)::float8" if box else "NULL::float8" for s in EUR_STREAMS)
    return ([
        "el.stick_id", "el.unique_id",
        f"{kind_sql('el')} AS category" if box else "'PDP' AS category",
        "UPPER(el.formation) AS formation", "el.formation_blueox", "el.basin AS basin_blueox",
        "el.formation_blueox_source", "el.tvd", "el.ll_ft",
        f"{in_filter} AS in_filter",
        f"{metric_expr} AS metric_value",
        f"{map_coverage_sql('el')} AS coverage" if box else "NULL::text AS coverage",
        *(f"{e} AS {s}_eur_ft" for e, s in zip(eur_ft, EUR_STREAMS)),
        "bpp.outcome AS prox_outcome" if box else "NULL::text AS prox_outcome",
        "ST_X(ST_LineInterpolatePoint(el.wellstick_geom, 0.5)) AS mx",
        "ST_Y(ST_LineInterpolatePoint(el.wellstick_geom, 0.5)) AS my",
        "ST_X(ST_StartPoint(el.wellstick_geom)) AS sx", "ST_Y(ST_StartPoint(el.wellstick_geom)) AS sy",
        "ST_X(ST_EndPoint(el.wellstick_geom)) AS ex", "ST_Y(ST_EndPoint(el.wellstick_geom)) AS ey",
    ])


def gunbarrel_sql(metric: str, where: list[str], econ: bool) -> str:
    """Two arms. Locations: the screened population in the pad (pad membership), each
    tagged in_filter = passes the current screen. PDP: producing horizontals whose lateral
    midpoint lies in the pad polygon (PDP has no pad membership) — always muted context."""
    in_filter = "(" + " AND ".join(where) + ")" if where else "true"
    return f"""
        WITH pad AS (
            SELECT geom FROM curated.intel_pad_geom WHERE basin = :basin AND pad_key = :pad_key
        )
        SELECT {', '.join(gb_columns(row_value_sql(metric), in_filter, True))}
        {_box_from(econ)}
        JOIN curated.intel_pad_member pm ON pm.stick_id = el.stick_id AND pm.pad_key = :pad_key
        WHERE {POPULATION} AND el.wellstick_geom IS NOT NULL AND el.tvd IS NOT NULL

        UNION ALL

        SELECT {', '.join(gb_columns("NULL::double precision", "false", False))}
        FROM curated.erebor_locations el
        CROSS JOIN pad
        WHERE el.basin = :basin AND el.category = 'PDP'
          AND el.wellstick_geom IS NOT NULL AND el.tvd IS NOT NULL
          AND ST_Contains(pad.geom, ST_LineInterpolatePoint(el.wellstick_geom, 0.5))
    """


def _f(v: Any) -> float | None:
    return float(v) if v is not None else None


@router.post("/gunbarrel")
def gunbarrel(body: GunbarrelBody, session: Session = Depends(get_session)) -> dict:
    """Gunbarrel cross-section for ONE DSU: every screened location + PDP in the unit,
    projecting each lateral's midpoint onto the axis perpendicular to the pad's mean
    azimuth (offset, ft) paired with TVD — same math as /api/gunbarrel. Nothing is hidden:
    each location carries `in_filter` (passes the current Highgrade screen) and
    `metric_value` (the screen metric; NULL = no BOX forecast / unpriced, never zero)."""
    run = record_run(session)
    case = econ_case(session, run["run_id"], body.deck)
    check_metric(body.metric, case is not None)
    econ = case is not None and (body.metric in ECON_METRICS or has_econ_range(body.filters))
    where, params, expanding = build_filters(body.filters, econ)
    params |= {"basin": body.basin, "pad_key": body.pad_key, "box_run": run["run_id"],
               **(_econ_params(case) if econ else {})}
    sql = text(gunbarrel_sql(body.metric, where, econ))
    if expanding:
        sql = sql.bindparams(*expanding)
    ws = session.execute(sql, params).mappings().all()
    if not ws:
        return {"pad_name": body.pad_key, "well_count": 0, "wells": []}

    lat0 = sum(w["my"] for w in ws) / len(ws)
    lon0 = sum(w["mx"] for w in ws) / len(ws)
    k = math.cos(math.radians(lat0))

    def to_m(lon, lat):
        return ((lon - lon0) * M_PER_DEG_LON * k, (lat - lat0) * M_PER_DEG_LAT)

    # Pad mean lateral direction (sum of heel->toe vectors) -> perpendicular axis.
    dx = dy = 0.0
    mids = []
    for w in ws:
        sxm, sym = to_m(w["sx"], w["sy"])
        exm, eym = to_m(w["ex"], w["ey"])
        dx += exm - sxm
        dy += eym - sym
        mids.append(to_m(w["mx"], w["my"]))
    norm = math.hypot(dx, dy)
    perp = (1.0, 0.0) if norm < 1e-9 else (-(dy / norm), dx / norm)
    perp, axis_left, axis_right = _canonical_axis(perp)
    cx = sum(m[0] for m in mids) / len(mids)
    cy = sum(m[1] for m in mids) / len(mids)

    wells = []
    for w, (mxm, mym) in zip(ws, mids):
        offset_ft = ((mxm - cx) * perp[0] + (mym - cy) * perp[1]) * FT_PER_M
        wells.append({
            "stick_id": w["stick_id"], "unique_id": w["unique_id"],
            "category": w["category"], "formation": w["formation"],
            "formation_blueox": w["formation_blueox"],
            "basin_blueox": w["basin_blueox"],
            "formation_blueox_source": w["formation_blueox_source"],
            "tvd": float(w["tvd"]), "ll_ft": _f(w["ll_ft"]),
            "offset_ft": round(offset_ft, 1), "in_filter": bool(w["in_filter"]),
            "metric_value": _f(w["metric_value"]),
            "coverage": w["coverage"],
            **{f"{s}_eur_ft": _f(w[f"{s}_eur_ft"]) for s in EUR_STREAMS},
            "prox_outcome": w["prox_outcome"],
        })
    wells.sort(key=lambda x: x["offset_ft"])
    return {
        "pad_name": body.pad_key, "well_count": len(wells),
        "axis_left": axis_left, "axis_right": axis_right,
        "wells": wells,
    }
