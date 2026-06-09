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
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(prefix="/highgrade", tags=["highgrade"])

_BASIN = Query(..., pattern="^(delaware|midland)$")

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

# Base predicate: PUD inventory only, in the requested basin, with a real pad.
_PUD_BASE = "category = 'PUD' AND basin = :basin"


# ---------------------------------------------------------------------------
# facets
# ---------------------------------------------------------------------------
@router.get("/facets")
def facets(basin: str = _BASIN, session: Session = Depends(get_session)) -> dict:
    """Distinct categorical values + numeric min/max over PUD inventory (one scan)."""
    cat_aggs = ",\n".join(
        f"array_agg(DISTINCT {c}) FILTER (WHERE {c} IS NOT NULL) AS {c}" for c in CATEGORICAL
    )
    num_aggs = ",\n".join(
        f"min({c}) AS {c}_min, max({c}) AS {c}_max" for c in NUMERIC
    )
    row = session.execute(
        text(f"SELECT {cat_aggs}, {num_aggs} FROM curated.intel_locations WHERE {_PUD_BASE}"),
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


def _value_expr(metric: str, agg: str) -> str:
    if metric == "well_count":
        return "count(*)"
    # per_acre's numerator is the per-pad sum; the /acre division happens in `joined`,
    # where the pad geometry (hence acreage) is available.
    fn = "avg" if agg == "avg" else "sum"
    return f"{fn}({metric})"  # metric validated against the Metric literal


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
    value_expr = _value_expr(body.metric, agg)
    # In per_acre mode the final value is sum/acre; otherwise it passes through.
    final_value = "a.value / NULLIF(p.acres, 0)" if agg == "per_acre" else "a.value"

    sql = text(f"""
        WITH agg AS (
            SELECT pad_name,
                   {value_expr} AS value,
                   count(*)     AS n_wells
            FROM curated.intel_locations
            WHERE {_PUD_BASE} AND pad_name IS NOT NULL {filt_sql}
            GROUP BY pad_name
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
