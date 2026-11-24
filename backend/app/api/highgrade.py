"""Highgrade tab: screen the basin's remaining stick locations for target pads, on BOX.

The inverse of /select's AOI rollup. The user filters the remaining locations by bench,
BOX value ranges, Steven's econ ranges and the PDP-proximity outcome, aggregates ONE
metric per pad (the Novi DSU polygons the record BOX stick set was generated in), and the
pads are colored low -> high so the best units matching the screen stand out.

Overhaul step 5 (docs/overhaul_plan.md): BOX-only. Since the BOX sticks cutover the
locations are BOX sticks; Novi supplies the DSU polygons, nothing else — no Novi stick,
tag (PUD / RES, tiers), forecast or NPV is read here.

  * Population = every BOX stick location in the basin (curated.erebor_locations,
    category <> 'PDP'). A stick the nightly reconciliation matched to production is not
    a row there; the realized_drift / realized_phantom exclusion is kept from the Novi
    sticks and matches nothing on BOX sticks. A conflict / crowded stick stays in the
    screen under its class (not_covered_conflict), never valued.
  * Pad = the stick's own DSU: curated.erebor_locations.pad_id (pad_key = its text), drawn
    from raw_novi_intel.pads at the record stick set's vintage
    (app.box_locations.dsu_polygons_sql). curated.intel_pad_member / intel_pad_geom knew
    only DSUs that held a Novi stick and are not read any more.
  * Values = the BOX record run (box.forecast_run.is_record) through app.box_locations:
    analog-workup EUR (D57/D62, uptime-free, raw 50-yr technical integral, the
    proximity factor (D113 table / D150 continuous) already inside the stored oil EUR;
    water since sql/62). Every
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
    ECON_METRICS, EUR_STREAMS, FORECAST_IN_SQL, LEG_COLUMNS, MAP_COVERAGE_CLASSES, PROX_GROUPS, box_joins,
    dsu_polygons_sql, econ_case, econ_join, econ_provenance, kind_sql, leg_join, line_columns, map_coverage_sql,
    record_run,
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
# context (rule 8), never screened. The realized_* statuses were the Novi sticks'
# reconciliation (sql/20 + sql/68); a BOX stick matched to production is not a row at all,
# so those two tests are a no-op kept for a pre-cutover warehouse.
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

# Range filters -> SQL ref. BOX bounds (stored units: bbl / mcf, per 1,000 ft, the
# proximity oil factor, the lateral BOX used) bound FORECAST locations only: a location without a
# BOX forecast stays in the screen, counted under its class, never dropped by a BOX bound
# (dropping it would hide the not-covered count, D67).
BOX_RANGES: dict[str, str] = {
    **{f"{s}_eur": f"bs{s[0]}.eur" for s in EUR_STREAMS},
    **{f"{s}_eur_per_kft": f"bs{s[0]}.eur_per_kft" for s in EUR_STREAMS},
    # D113 runs: 1 = as-is, 0.75-0.94 = multi-parent haircut; D150 runs: level x F on every
    # forecast PUD, ~0.4-1.5 (level 1.046 Delaware / 1.067 Midland on an unexposed PUD)
    "prox_factor": "bso.prox_factor",
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
    run = record_run(session, basin)
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


_VALUED_PAD = "geom IS NOT NULL AND value IS NOT NULL AND n_valued > 0"


def pads_sql(metric: str, agg: str, filt_sql: str, econ: bool) -> str:
    v_expr = value_expr(metric, agg)
    n_valued = n_valued_expr(metric)
    final_value = "a.value / NULLIF(p.acres, 0)" if resolve_agg(metric, agg) == "per_acre" else "a.value"
    cov = map_coverage_sql("el")
    # one count per coverage class per pad + the valued wells per tier (D105: the pad
    # value carries both tiers, so its make-up is reported, never folded into one count)
    cov_cols = "".join(f", count(*) FILTER (WHERE {cov} = '{c}') AS nc_{c}" for c in HG_COVERAGE_CLASSES)
    cov_cols += "".join(f", {n_valued_expr(metric, coverage=c)} AS nv_{t}" for t, c in _TIERS.items())
    # PDP-proximity outcome counts per pad + the oil factor range of the pad's multi-parent
    # ("haircut" group: D113 haircut + D150 factor_multi_parent) locations — the group the
    # range sits beside in the UI; D150 single-parent / unexposed factors are per-stick
    hc = _in_list(PROX_GROUPS["haircut"])
    cov_cols += "".join(f", count(*) FILTER (WHERE bpp.outcome IN {_in_list(o)}) AS np_{g}" for g, o in PROX_GROUPS.items())
    cov_cols += (f", min(bpp.factor) FILTER (WHERE bpp.outcome IN {hc}) AS prox_min"
                 f", max(bpp.factor) FILTER (WHERE bpp.outcome IN {hc}) AS prox_max")
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
            -- per DSU: the Novi DSU the BOX stick was generated in (el.pad_id; pad_key = its
            -- text). A row without one -> pad_key NULL -> wells_without_pad.
            SELECT el.pad_id::text AS pad_key, max(el.pad_name) AS stick_pad_name,
                   {v_expr}   AS value,
                   {n_valued} AS n_valued,
                   count(*)   AS n_wells
                   {cov_cols}
            {_box_from(econ)}
            WHERE {POPULATION} {filt_sql}
            GROUP BY el.pad_id
        ),
        -- the DSU polygons of the basin's record stick set (raw_novi_intel.pads at its vintage)
        dsu AS ({dsu_polygons_sql()}),
        joined AS (
            -- one polygon per DSU, always Novi's own: n_parts / geom_source are constants kept
            -- for the response shape (the [k/n] splits and stick hulls of sql/67 are gone)
            SELECT a.pad_key, COALESCE(p.pad_name, a.stick_pad_name) AS pad_name, 1 AS n_parts,
                   'novi_polygon'::text AS geom_source, {final_value} AS value,
                   a.n_valued, a.n_wells, p.acres, p.geom {sel}
            FROM agg a
            LEFT JOIN dsu p ON p.pad_id::text = a.pad_key
            WHERE a.pad_key IS NOT NULL
        )
        SELECT json_build_object(
            'pad_count',         count(*) FILTER (WHERE geom IS NOT NULL),
            'pads_missing_geom', count(*) FILTER (WHERE geom IS NULL),
            -- always 0 since the BOX sticks cutover (one Novi polygon per DSU); kept for the shape
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
            -- the color scale: P5 / P50 / P95 of the drawn, valued pads, so one huge stacked
            -- DSU cannot compress every other pad into one end of the ramp (clamped client-side;
            -- min / max above stay the true range)
            'value_p5',  percentile_cont(0.05) WITHIN GROUP (ORDER BY value) FILTER (WHERE {_VALUED_PAD}),
            'value_p50', percentile_cont(0.50) WITHIN GROUP (ORDER BY value) FILTER (WHERE {_VALUED_PAD}),
            'value_p95', percentile_cont(0.95) WITHIN GROUP (ORDER BY value) FILTER (WHERE {_VALUED_PAD}),
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
    run = record_run(session, body.basin)
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
    pad_key: str  # the DSU: curated.erebor_locations.pad_id (= raw_novi_intel.pads.pad_id) as text
    filters: HighgradeFilters = Field(default_factory=HighgradeFilters)
    metric: Metric = "oil_eur_per_kft"
    deck: str | None = Field(None, max_length=64)


def gb_columns(metric_expr: str, in_filter: str, box: bool) -> list[str]:
    """Select list shared by both gunbarrel arms (UNION ALL: same columns, same order).
    The PDP arm carries NULL BOX values — producing context, never forecast (rule 8).
    The location arm is one row per LEG of a BOX stick (box_locations.leg_join: a U-turn
    stick has two); a producing well is its own one leg."""
    eur_ft = (f"round((bs{s[0]}.eur_per_kft / 1000.0)::numeric, 1)::float8" if box else "NULL::float8" for s in EUR_STREAMS)
    return ([
        "el.stick_id", "el.unique_id",
        f"{kind_sql('el')} AS category" if box else "'PDP' AS category",
        "UPPER(el.formation) AS formation", "el.formation_blueox", "el.basin AS basin_blueox",
        "el.formation_blueox_source", "el.tvd", "el.ll_ft", "el.pad_name",
        f"{in_filter} AS in_filter",
        f"{metric_expr} AS metric_value",
        f"{map_coverage_sql('el')} AS coverage" if box else "NULL::text AS coverage",
        *(f"{e} AS {s}_eur_ft" for e, s in zip(eur_ft, EUR_STREAMS)),
        "bpp.outcome AS prox_outcome" if box else "NULL::text AS prox_outcome",
        LEG_COLUMNS if box else "1 AS leg_no, 1 AS n_legs, " + line_columns("el.wellstick_geom"),
    ])


def gunbarrel_sql(metric: str, where: list[str], econ: bool) -> str:
    """Two arms. Locations: the screened population in the DSU (el.pad_id), one row per
    leg, each tagged in_filter = passes the current screen. PDP: producing horizontals whose
    lateral midpoint lies in the DSU polygon (PDP has no pad_id) — always muted context;
    without a polygon for the DSU that arm is empty."""
    in_filter = "(" + " AND ".join(where) + ")" if where else "true"
    return f"""
        WITH pad AS (
            SELECT d.geom FROM ({dsu_polygons_sql()}) d WHERE d.pad_id::text = :pad_key
        )
        SELECT {', '.join(gb_columns(row_value_sql(metric), in_filter, True))}
        {_box_from(econ)}
        {leg_join('el')}
        WHERE {POPULATION} AND el.pad_id::text = :pad_key
          AND el.wellstick_geom IS NOT NULL AND el.tvd IS NOT NULL

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
    projecting each leg's midpoint onto the axis perpendicular to the pad's (axial) mean
    azimuth (offset, ft) paired with TVD — same math as /api/gunbarrel, one point per leg
    of a U-turn stick. Nothing is hidden:
    each location carries `in_filter` (passes the current Highgrade screen) and
    `metric_value` (the screen metric; NULL = no BOX forecast / unpriced, never zero)."""
    run = record_run(session, body.basin)
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
        return {"pad_name": body.pad_key, "well_count": 0, "stick_count": 0, "wells": []}

    lat0 = sum(w["my"] for w in ws) / len(ws)
    lon0 = sum(w["mx"] for w in ws) / len(ws)
    k = math.cos(math.radians(lat0))

    def to_m(lon, lat):
        return ((lon - lon0) * M_PER_DEG_LON * k, (lat - lat0) * M_PER_DEG_LAT)

    # Pad mean lateral direction -> perpendicular axis. AXIAL sum: the two legs of a U-turn
    # stick run opposite ways (and producers are drilled both ways), so each heel->toe vector
    # is turned to agree with the first before summing — opposite vectors would cancel.
    dx = dy = 0.0
    mids = []
    ref = None
    for w in ws:
        sxm, sym = to_m(w["sx"], w["sy"])
        exm, eym = to_m(w["ex"], w["ey"])
        vx, vy = exm - sxm, eym - sym
        if ref is None:
            ref = (vx, vy)
        elif vx * ref[0] + vy * ref[1] < 0:
            vx, vy = -vx, -vy
        dx += vx
        dy += vy
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
            "leg_no": int(w["leg_no"]), "n_legs": int(w["n_legs"]),
            "offset_ft": round(offset_ft, 1), "in_filter": bool(w["in_filter"]),
            "metric_value": _f(w["metric_value"]),
            "coverage": w["coverage"],
            **{f"{s}_eur_ft": _f(w[f"{s}_eur_ft"]) for s in EUR_STREAMS},
            "prox_outcome": w["prox_outcome"],
        })
    wells.sort(key=lambda x: (x["offset_ft"], x["stick_id"], x["leg_no"]))
    # the DSU's name from its sticks (a producing well carries none); the key when it has none
    name = next((w["pad_name"] for w in ws if w["pad_name"]), None) or body.pad_key
    return {
        # well_count = points (one per leg); stick_count = distinct sticks / wells
        "pad_name": name, "pad_key": body.pad_key, "well_count": len(wells),
        "stick_count": len({w["stick_id"] for w in wells}),
        "axis_left": axis_left, "axis_right": axis_right,
        "wells": wells,
    }
