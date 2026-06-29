"""Highgrade tab: screen the basin's undeveloped PUD inventory for target pads.

The inverse of /select's AOI valuation. The user filters PUD inventory by technical
+ economic attributes (tiers/scores from the ML layer, formation, operator, NPV,
EUR, ...), aggregates a chosen metric PER PAD, and the pad polygons are colored
hot->cold so the highest-value units matching the criteria stand out on the map.

Two endpoints:
  GET  /api/highgrade/facets?basin=  -> distinct categoricals + numeric min/max,
       over PUD inventory, to populate the filter UI (one table scan).
  POST /api/highgrade/pads           -> {basin, filters, metric, agg} aggregated
       per pad_name, joined to the pad polygons, as a FeatureCollection + the
       value range for the color scale.

Economics are Novi's pre-computed screen on a flat deck (a screen, not the
authoritative value) — consistent with the rest of erebor.
"""

from __future__ import annotations

import json
import math
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(prefix="/highgrade", tags=["highgrade"])

_BASIN = Query(..., pattern="^(delaware|midland)$")

# Local planar approximation for the single-pad gunbarrel projection (see below).
M_PER_DEG_LAT = 110540.0
M_PER_DEG_LON = 111320.0
FT_PER_M = 3.28084

# Whitelists — every column/metric that can reach SQL is validated against these,
# so list/range filters and the metric expression are never free-text-interpolated.
CATEGORICAL: tuple[str, ...] = ("formation", "operator", "spacing_t", "deplet_t", "complet_t", "rqt")
NUMERIC: tuple[str, ...] = (
    "spacing_s", "deplet_s", "complet_s", "rqs",
    "npv5", "npv10", "npv15", "npv20", "npv25",
    "pv5", "pv10", "pv15", "pv20", "pv25",
    "oil_eur", "gas_eur", "ll_ft", "tvd", "fp_year",
)
# Selectable per-pad metrics. NPV/PV/EUR aggregate via sum|avg; well_count is a count.
Metric = Literal[
    "npv5", "npv10", "npv15", "npv20", "npv25",
    "pv5", "pv10", "pv15", "pv20", "pv25",
    "oil_eur", "gas_eur", "well_count",
]
Agg = Literal["sum", "avg", "per_acre"]

# Base predicate: PUD inventory only, in the requested basin. `il` aliases
# curated.intel_locations in every query below.
_PUD_BASE = "il.category = 'PUD' AND il.basin = :basin"

# §6 reconciliation gate. By default Highgrade screens only DRILLABLE inventory:
# PUDs the reconciliation (curated.reconciled_inventory) did NOT confirm as already
# drilled. remaining_pud + conflict (+ any unreconciled PUD) stay in; realized_drift
# and realized_phantom drop out. include_realized=True removes the gate to screen the
# full Novi PUD set. reconciled_inventory is UNIQUE on stick_id, so the LEFT JOIN
# never multiplies rows; IS DISTINCT FROM keeps unreconciled (NULL-status) PUDs in.
_DRILLABLE = (
    "rec.status IS DISTINCT FROM 'realized_drift' "
    "AND rec.status IS DISTINCT FROM 'realized_phantom'"
)


def _recon_join(left_alias: str) -> str:
    return f"LEFT JOIN curated.reconciled_inventory rec ON rec.stick_id = {left_alias}.stick_id"


# ---------------------------------------------------------------------------
# facets
# ---------------------------------------------------------------------------
@router.get("/facets")
def facets(
    basin: str = _BASIN,
    include_realized: bool = Query(False),
    session: Session = Depends(get_session),
) -> dict:
    """Distinct categorical values + numeric min/max over the screened PUD set."""
    cat_aggs = ",\n".join(
        f"array_agg(DISTINCT il.{c}) FILTER (WHERE il.{c} IS NOT NULL) AS {c}" for c in CATEGORICAL
    )
    num_aggs = ",\n".join(
        f"min(il.{c}) AS {c}_min, max(il.{c}) AS {c}_max" for c in NUMERIC
    )
    recon = "" if include_realized else f" AND {_DRILLABLE}"
    row = session.execute(
        text(
            f"SELECT {cat_aggs}, {num_aggs} "
            f"FROM curated.intel_locations il {_recon_join('il')} "
            f"WHERE {_PUD_BASE}{recon}"
        ),
        {"basin": basin},
    ).mappings().one()

    categorical = {c: sorted(row[c] or []) for c in CATEGORICAL}
    numeric = {c: {"min": row[f"{c}_min"], "max": row[f"{c}_max"]} for c in NUMERIC}
    return {"basin": basin, "categorical": categorical, "numeric": numeric}


# ---------------------------------------------------------------------------
# pads (filtered per-pad aggregation -> choropleth)
# ---------------------------------------------------------------------------
class HighgradeFilters(BaseModel):
    # categorical multi-selects (omit/empty -> no constraint on that field)
    formation: list[str] | None = None
    operator: list[str] | None = None
    spacing_t: list[str] | None = None
    deplet_t: list[str] | None = None
    complet_t: list[str] | None = None
    rqt: list[str] | None = None
    # numeric ranges keyed by whitelisted column -> [min, max] (either side nullable)
    ranges: dict[str, tuple[float | None, float | None]] = Field(default_factory=dict)


class PadsBody(BaseModel):
    basin: Literal["delaware", "midland"]
    filters: HighgradeFilters = Field(default_factory=HighgradeFilters)
    metric: Metric = "npv25"
    agg: Agg = "sum"
    include_realized: bool = False  # False -> drillable inventory only (see _DRILLABLE)


def _value_expr(metric: str, agg: str) -> str:
    if metric == "well_count":
        return "count(*)"
    # per_acre's numerator is the per-pad sum; the /acre division happens in `joined`,
    # where the pad geometry (hence acreage) is available.
    fn = "avg" if agg == "avg" else "sum"
    return f"{fn}(il.{metric})"  # metric validated against the Metric literal


def _build_filters(filters: HighgradeFilters) -> tuple[list[str], dict, list]:
    """Return (where_fragments, params, expanding_bindparams) from validated filters."""
    clauses: list[str] = []
    params: dict = {}
    expanding: list = []

    for col in CATEGORICAL:
        vals = getattr(filters, col)
        if vals:
            clauses.append(f"{col} IN :{col}")
            params[col] = list(vals)
            expanding.append(bindparam(col, expanding=True))

    for col, bounds in (filters.ranges or {}).items():
        if col not in NUMERIC:
            continue  # silently ignore unknown columns rather than trust input
        lo, hi = bounds
        if lo is not None:
            clauses.append(f"{col} >= :{col}_lo")
            params[f"{col}_lo"] = lo
        if hi is not None:
            clauses.append(f"{col} <= :{col}_hi")
            params[f"{col}_hi"] = hi

    return clauses, params, expanding


@router.post("/pads")
def pads(body: PadsBody, session: Session = Depends(get_session)) -> dict:
    # per_acre divides the per-pad sum by the DSU acreage; only meaningful for the
    # $-denominated metrics. Coerce anything else back to a plain sum defensively.
    agg = body.agg
    if agg == "per_acre" and not body.metric.startswith(("npv", "pv")):
        agg = "sum"

    where, params, expanding = _build_filters(body.filters)
    params["basin"] = body.basin
    filt_sql = ("AND " + " AND ".join(where)) if where else ""
    recon = "" if body.include_realized else f" AND {_DRILLABLE}"
    value_expr = _value_expr(body.metric, agg)
    # In per_acre mode the final value is sum/acre; otherwise it passes through.
    final_value = "a.value / NULLIF(p.acres, 0)" if agg == "per_acre" else "a.value"

    sql = text(f"""
        WITH agg AS (
            SELECT il.pad_name,
                   {value_expr} AS value,
                   count(*)     AS n_wells
            FROM curated.intel_locations il {_recon_join('il')}
            WHERE {_PUD_BASE} AND il.pad_name IS NOT NULL {filt_sql}{recon}
            GROUP BY il.pad_name
        ),
        pad_geom AS (
            -- one geometry per pad_name; raw_novi_intel.pads has duplicate pad rows
            -- (Delaware 4, Midland 126) that would otherwise multiply the join.
            -- Geodesic area (geography) -> acres, valid across TX + NM with no zone choice.
            SELECT DISTINCT ON (pad_name) pad_name, geom,
                   ST_Area(geom::geography) / 4046.8564224 AS acres
            FROM raw_novi_intel.pads
            WHERE basin = :basin AND pad_name IS NOT NULL AND geom IS NOT NULL
            ORDER BY pad_name, pad_id
        ),
        joined AS (
            SELECT a.pad_name, {final_value} AS value, a.n_wells, p.acres, p.geom
            FROM agg a
            LEFT JOIN pad_geom p ON p.pad_name = a.pad_name
        )
        SELECT json_build_object(
            'pad_count',         count(*) FILTER (WHERE geom IS NOT NULL),
            'pads_missing_geom', count(*) FILTER (WHERE geom IS NULL),
            'well_count',        COALESCE(sum(n_wells), 0),
            'value_min',         min(value) FILTER (WHERE geom IS NOT NULL),
            'value_max',         max(value) FILTER (WHERE geom IS NOT NULL),
            'pads', json_build_object(
                'type', 'FeatureCollection',
                'features', COALESCE(json_agg(
                    json_build_object(
                        'type', 'Feature',
                        'geometry', ST_AsGeoJSON(geom)::json,
                        'properties', json_build_object(
                            'pad_name', pad_name, 'value', value, 'n_wells', n_wells,
                            'acres', round(acres::numeric, 1)
                        )
                    )) FILTER (WHERE geom IS NOT NULL), '[]'::json)
            )
        )::text
        FROM joined
    """)
    if expanding:
        sql = sql.bindparams(*expanding)

    result = json.loads(session.execute(sql, params).scalar())
    return {"basin": body.basin, "metric": body.metric, "agg": agg, **result}


# ---------------------------------------------------------------------------
# gunbarrel (per-DSU cross-section)
# ---------------------------------------------------------------------------
class GunbarrelBody(BaseModel):
    basin: Literal["delaware", "midland"]
    pad_name: str
    filters: HighgradeFilters = Field(default_factory=HighgradeFilters)
    metric: Metric = "npv25"
    include_realized: bool = False  # gates the in_filter highlight, matching the choropleth


@router.post("/gunbarrel")
def gunbarrel(body: GunbarrelBody, session: Session = Depends(get_session)) -> dict:
    """Gunbarrel cross-section for ONE DSU.

    Returns every PUD + PDP well in the unit (RES excluded), projecting each
    lateral's midpoint onto the axis perpendicular to the pad's mean azimuth
    (offset, ft) paired with TVD — same math as /api/gunbarrel. Every well is
    returned regardless of the active screen; instead each carries `in_filter`
    (true only for a PUD that passes the current Highgrade filters), so the
    client renders off-filter PUDs and all PDPs muted rather than hiding them.
    Each well also carries `metric_value` for the currently-selected screen
    metric (null for the count metric, which has no per-well value).

    PUD/RES carry a real pad_name; PDP's is a placeholder, so PDP wells are
    pulled by spatially containing their lateral midpoint in this DSU polygon.
    """
    where, params, expanding = _build_filters(body.filters)
    # in_filter is true only for a PUD matching every active filter clause; PDP
    # (and any off-filter PUD) -> false. `category` is always the PUD gate, so a
    # PDP can never be in_filter even when the filter set is empty. The drillable
    # gate (unless include_realized) keeps realized/phantom PUDs visible but
    # un-highlighted, matching the choropleth's screened population.
    gate = ["w.category = 'PUD'", *where]
    if not body.include_realized:
        gate.append(_DRILLABLE)
    in_filter_expr = "CASE WHEN " + " AND ".join(gate) + " THEN true ELSE false END"
    # metric is validated against the Metric literal; well_count has no per-well value.
    metric_expr = "NULL" if body.metric == "well_count" else f"w.{body.metric}"
    params["basin"] = body.basin
    params["pad_name"] = body.pad_name

    sql = text(f"""
        WITH pad AS (
            -- one polygon per pad_name (raw_novi_intel.pads has duplicate rows)
            SELECT geom FROM raw_novi_intel.pads
            WHERE basin = :basin AND pad_name = :pad_name AND geom IS NOT NULL
            ORDER BY pad_id LIMIT 1
        )
        SELECT w.stick_id, w.unique_id, w.category, UPPER(w.formation) AS formation,
               fb.formation_blueox, w.basin AS basin_blueox, fb.formation_blueox_source,
               w.tvd, w.ll_ft, {in_filter_expr} AS in_filter,
               {metric_expr} AS metric_value,
               ST_X(ST_LineInterpolatePoint(w.wellstick_geom, 0.5)) AS mx,
               ST_Y(ST_LineInterpolatePoint(w.wellstick_geom, 0.5)) AS my,
               ST_X(ST_StartPoint(w.wellstick_geom)) AS sx,
               ST_Y(ST_StartPoint(w.wellstick_geom)) AS sy,
               ST_X(ST_EndPoint(w.wellstick_geom))   AS ex,
               ST_Y(ST_EndPoint(w.wellstick_geom))   AS ey
        FROM curated.intel_locations w
        LEFT JOIN pad ON true
        LEFT JOIN curated.intel_formation_blueox fb ON fb.stick_id = w.stick_id
        {_recon_join('w')}
        WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL AND w.tvd IS NOT NULL
          AND (
            (w.category = 'PUD' AND w.pad_name = :pad_name)
            OR (w.category = 'PDP' AND pad.geom IS NOT NULL
                AND ST_Contains(pad.geom, ST_LineInterpolatePoint(w.wellstick_geom, 0.5)))
          )
    """)
    if expanding:
        sql = sql.bindparams(*expanding)
    ws = session.execute(sql, params).mappings().all()
    if not ws:
        return {"pad_name": body.pad_name, "well_count": 0, "wells": []}

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
            "tvd": float(w["tvd"]),
            "ll_ft": float(w["ll_ft"]) if w["ll_ft"] is not None else None,
            "offset_ft": round(offset_ft, 1), "in_filter": bool(w["in_filter"]),
            "metric_value": float(w["metric_value"]) if w["metric_value"] is not None else None,
        })
    wells.sort(key=lambda x: x["offset_ft"])
    return {"pad_name": body.pad_name, "well_count": len(wells), "wells": wells}
