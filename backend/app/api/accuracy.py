"""Accuracy tab: Novi Intelligence forecast vs realized actuals.

Reads curated.intel_forecast_accuracy (engineering_db sql/38): one row per
Novi-blind producer per aligned month (api10, mop 1-24). Two tiers —
'direct' (the well co-extent-realized a PUD stick; raw + per-ft cum errors)
and 'proxy' (per-ft median of the representative infill set; per-ft only).

Three endpoints:
  GET /api/accuracy/wells?basin=      -> FeatureCollection of the drilled
      laterals with per-horizon (3/6/9/12) errors as properties, for the map
      layer; all error variants ship at once so stream/norm/horizon switches
      are client-side.
  GET /api/accuracy/summary?...       -> headline bias/MAE at the chosen
      horizon + by-month / by-tier / by-bench / by-operator slices + a
      per-well error histogram, under tier/bench/operator filters.
  GET /api/accuracy/well?api10=       -> one well's forecast-vs-actual series
      plus a neighborhood gunbarrel (subject + comparison sticks + PDP/PUD
      context within 1 mi), comparison sticks flagged.

Conventions carried from the matview (see its COMMENT): errors are cum-based;
rows flagged is_latest_reported are excluded from every aggregate and from the
per-horizon map properties; mop 1-2 carry the partial-first-month bias (the
frontend mutes them); Novi is P50, so bias (mean error) is the calibration
number and MAE is dispersion.
"""

from __future__ import annotations

import json
import math
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(prefix="/accuracy", tags=["accuracy"])

_BASIN = Query(..., pattern="^(delaware|midland)$")
_API10 = Query(..., pattern=r"^\d{10}$")

# Local planar approximation for the gunbarrel projection (same constants as
# highgrade.py / gunbarrel.py).
M_PER_DEG_LAT = 110540.0
M_PER_DEG_LON = 111320.0
FT_PER_M = 3.28084


def _canonical_axis(perp: tuple[float, float]) -> tuple[tuple[float, float], str, str]:
    """Canonicalize the cross-section axis to the suite-wide gunbarrel reading
    (same rule as anduin's dossier/inspect charts and narvi's panel): a ~N-S
    lateral set (axis runs E-W) reads W -> E, a ~E-W set (axis runs N-S) reads
    N -> S. The mean heel->toe direction is data-order arbitrary, so the
    DOMINANT compass component of the perpendicular decides and the sign flips
    to match. Copy-shared with gunbarrel.py / highgrade.py (like the projection
    constants). Returns (axis, left_label, right_label)."""
    px, py = perp  # (east, north) components
    if abs(px) >= abs(py):  # axis runs E-W: +offset = East
        return ((-px, -py) if px < 0 else (px, py)), "W", "E"
    return ((-px, -py) if py > 0 else (px, py)), "N", "S"  # +offset = South

HORIZONS: tuple[int, ...] = (3, 6, 9, 12)
Stream = Literal["oil", "gas", "water"]
Norm = Literal["perft", "raw"]
Tier = Literal["all", "direct", "proxy"]

# Whitelist: (stream, norm) -> matview error column. Everything interpolated
# into SQL below comes from this dict or the Literal-validated params.
_ERR_COL: dict[tuple[str, str], str] = {
    ("oil", "perft"): "pct_err_oil_perft",
    ("gas", "perft"): "pct_err_gas_perft",
    ("water", "perft"): "pct_err_water_perft",
    ("oil", "raw"): "pct_err_oil",
    ("gas", "raw"): "pct_err_gas",
    ("water", "raw"): "pct_err_water",
}

# Rep-stick selection tolerance per basin (Blue Ox ledger §9) — must match the
# matview's rep CTE so the modal shows the same benchmark set the errors used.
_REP_TOL = {"delaware": 0.25, "midland": 0.40}
_REP_RADIUS_M = 1609.0


# ---------------------------------------------------------------------------
# wells (map layer)
# ---------------------------------------------------------------------------
@router.get("/wells")
def wells(basin: str = _BASIN, session: Session = Depends(get_session)) -> dict:
    """Drilled laterals of every Novi-blind producer in the basin, with the
    error at each horizon for every stream/norm as feature properties (null
    when history is short, the horizon month is the latest reported, or the
    tier/coverage leaves the error undefined — the client renders those grey).
    """
    err_props = ",\n".join(
        f"'err{h}_{s}{'' if n == 'raw' else '_perft'}', "
        f"max({_ERR_COL[(s, n)]}) FILTER (WHERE mop = {h} AND NOT is_latest_reported)"
        for h in HORIZONS
        for s in ("oil", "gas", "water")
        for n in ("perft", "raw")
    )
    sql = text(f"""
        WITH per_well AS (
            SELECT api10,
                   max(tier)                    AS tier,
                   max(operator)                AS operator,
                   COALESCE(max(formation_blueox), '(unmapped)') AS formation_blueox,
                   max(pad_name)                AS pad_name,
                   max(first_production_date)   AS first_prod,
                   max(mop)                     AS n_months,
                   max(ll_ratio)                AS ll_ratio,
                   max(n_rep)                   AS n_rep,
                   bool_or(low_n)               AS low_n,
                   max(n_sticks_for_well)       AS n_sticks_for_well,
                   jsonb_build_object({err_props}) AS errs
            FROM curated.intel_forecast_accuracy
            WHERE basin = :basin
            GROUP BY api10
        )
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(jsonb_agg(
                jsonb_build_object(
                    'type', 'Feature',
                    'geometry', ST_AsGeoJSON(pr.geom)::jsonb,
                    'properties', jsonb_build_object(
                        'api10', w.api10, 'tier', w.tier, 'operator', w.operator,
                        'formation_blueox', w.formation_blueox,
                        'pad_name', w.pad_name,
                        'first_prod', w.first_prod,
                        'n_months', w.n_months,
                        'll_ratio', round(w.ll_ratio::numeric, 3),
                        'n_rep', w.n_rep, 'low_n', w.low_n,
                        'n_sticks_for_well', w.n_sticks_for_well
                    ) || w.errs
                )), '[]'::jsonb)
        )::text
        FROM per_well w
        JOIN curated.producing_reference pr ON pr.api10 = w.api10
    """)
    fc = json.loads(session.execute(sql, {"basin": basin}).scalar())
    return {"basin": basin, "well_count": len(fc["features"]), "wells": fc}


# ---------------------------------------------------------------------------
# summary (panel stats)
# ---------------------------------------------------------------------------
@router.get("/summary")
def summary(
    basin: str = _BASIN,
    tier: Tier = "all",
    stream: Stream = "oil",
    norm: Norm = "perft",
    horizon: int = Query(6, ge=1, le=24),
    bench: list[str] | None = Query(None),
    operator: list[str] | None = Query(None),
    session: Session = Depends(get_session),
) -> dict:
    """Aggregate accuracy under the active filters. Bias = mean percent error
    (the P50 calibration number), MAE = mean absolute percent error
    (dispersion). Raw-norm errors only exist on the direct tier — with
    norm=raw the proxy rows drop out via their NULL errors and the returned
    n says so."""
    err = _ERR_COL[(stream, norm)]

    clauses = ["basin = :basin", "NOT is_latest_reported"]
    params: dict = {"basin": basin, "horizon": horizon}
    expanding = []
    if tier != "all":
        clauses.append("tier = :tier")
        params["tier"] = tier
    if bench:
        clauses.append("COALESCE(formation_blueox, '(unmapped)') IN :bench")
        params["bench"] = list(bench)
        expanding.append(bindparam("bench", expanding=True))
    if operator:
        clauses.append("operator IN :operator")
        params["operator"] = list(operator)
        expanding.append(bindparam("operator", expanding=True))
    where = " AND ".join(clauses)

    def q(sql_text: str):
        sql = text(sql_text)
        if expanding:
            sql = sql.bindparams(*expanding)
        return session.execute(sql, params)

    headline = q(f"""
        SELECT count(*) AS n,
               avg({err})              AS bias_pct,
               avg(abs({err}))         AS mae_pct,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY {err}) AS median_pct
        FROM curated.intel_forecast_accuracy
        WHERE {where} AND mop = :horizon AND {err} IS NOT NULL
    """).mappings().one()

    by_month = q(f"""
        SELECT mop, count(*) AS n, avg({err}) AS bias_pct, avg(abs({err})) AS mae_pct
        FROM curated.intel_forecast_accuracy
        WHERE {where} AND {err} IS NOT NULL
        GROUP BY mop ORDER BY mop
    """).mappings().all()

    by_tier = q(f"""
        SELECT tier, count(*) AS n, avg({err}) AS bias_pct, avg(abs({err})) AS mae_pct
        FROM curated.intel_forecast_accuracy
        WHERE {where} AND mop = :horizon AND {err} IS NOT NULL
        GROUP BY tier ORDER BY tier
    """).mappings().all()

    by_bench = q(f"""
        SELECT COALESCE(formation_blueox, '(unmapped)') AS formation_blueox,
               count(*) AS n, avg({err}) AS bias_pct, avg(abs({err})) AS mae_pct
        FROM curated.intel_forecast_accuracy
        WHERE {where} AND mop = :horizon AND {err} IS NOT NULL
        GROUP BY 1 ORDER BY n DESC
    """).mappings().all()

    by_operator = q(f"""
        SELECT operator, count(*) AS n, avg({err}) AS bias_pct, avg(abs({err})) AS mae_pct
        FROM curated.intel_forecast_accuracy
        WHERE {where} AND mop = :horizon AND {err} IS NOT NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 15
    """).mappings().all()

    ll_ratio = q(f"""
        SELECT avg(ll_ratio) AS mean,
               percentile_cont(0.1) WITHIN GROUP (ORDER BY ll_ratio) AS p10,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY ll_ratio) AS p90
        FROM (
            SELECT DISTINCT api10, ll_ratio
            FROM curated.intel_forecast_accuracy
            WHERE {where} AND tier = 'direct' AND ll_ratio IS NOT NULL
        ) d
    """).mappings().one()

    # Per-well error histogram at the horizon: 20 bins over [-100%, +100%],
    # errors beyond the range clamped into the end bins.
    hist_rows = q(f"""
        SELECT width_bucket(LEAST(GREATEST({err}, -1.0), 0.9999), -1.0, 1.0, 20) AS bin,
               count(*) AS n
        FROM curated.intel_forecast_accuracy
        WHERE {where} AND mop = :horizon AND {err} IS NOT NULL
        GROUP BY 1
    """).mappings().all()
    counts = [0] * 20
    for r in hist_rows:
        counts[int(r["bin"]) - 1] += int(r["n"])
    bin_edges = [round(-1.0 + i * 0.1, 1) for i in range(21)]

    def _f(v):
        return float(v) if v is not None else None

    return {
        "basin": basin, "tier": tier, "stream": stream, "norm": norm,
        "horizon": horizon,
        "headline": {
            "mop": horizon, "n": int(headline["n"]),
            "bias_pct": _f(headline["bias_pct"]),
            "mae_pct": _f(headline["mae_pct"]),
            "median_pct": _f(headline["median_pct"]),
        },
        "by_month": [
            {"mop": int(r["mop"]), "n": int(r["n"]),
             "bias_pct": _f(r["bias_pct"]), "mae_pct": _f(r["mae_pct"])}
            for r in by_month
        ],
        "by_tier": [
            {"tier": r["tier"], "n": int(r["n"]),
             "bias_pct": _f(r["bias_pct"]), "mae_pct": _f(r["mae_pct"])}
            for r in by_tier
        ],
        "by_bench": [
            {"formation_blueox": r["formation_blueox"], "n": int(r["n"]),
             "bias_pct": _f(r["bias_pct"]), "mae_pct": _f(r["mae_pct"])}
            for r in by_bench
        ],
        "by_operator": [
            {"operator": r["operator"], "n": int(r["n"]),
             "bias_pct": _f(r["bias_pct"]), "mae_pct": _f(r["mae_pct"])}
            for r in by_operator
        ],
        "ll_ratio": {"mean": _f(ll_ratio["mean"]), "p10": _f(ll_ratio["p10"]),
                     "p90": _f(ll_ratio["p90"])},
        "histogram": {"bin_edges": bin_edges, "counts": counts},
    }


# ---------------------------------------------------------------------------
# grid (regional bias choropleth: mean error per map cell, per bench filter)
# ---------------------------------------------------------------------------
@router.get("/grid")
def grid(
    basin: str = _BASIN,
    tier: Tier = "all",
    stream: Stream = "oil",
    norm: Norm = "perft",
    horizon: int = Query(6, ge=1, le=24),
    bench: list[str] | None = Query(None),
    operator: list[str] | None = Query(None),
    cell: float = Query(0.1, ge=0.02, le=0.5),  # degrees; 0.1 ≈ 6 mi N-S
    session: Session = Depends(get_session),
) -> dict:
    """Regional forecast bias: wells snapped to `cell`-degree map cells (by
    lateral midpoint), mean/mae percent error per cell at the horizon month.
    Basin-wide per-bench or per-operator means hide exactly this — the point
    is WHERE a bench's forecast runs hot or cold. Cells always return their n;
    the client greys thin cells rather than hiding them."""
    err = _ERR_COL[(stream, norm)]
    clauses = ["a.basin = :basin", "NOT a.is_latest_reported",
               "a.mop = :horizon", f"a.{err} IS NOT NULL"]
    params: dict = {"basin": basin, "horizon": horizon, "cell": cell}
    expanding = []
    if tier != "all":
        clauses.append("a.tier = :tier")
        params["tier"] = tier
    if bench:
        clauses.append("COALESCE(a.formation_blueox, '(unmapped)') IN :bench")
        params["bench"] = list(bench)
        expanding.append(bindparam("bench", expanding=True))
    if operator:
        clauses.append("a.operator IN :operator")
        params["operator"] = list(operator)
        expanding.append(bindparam("operator", expanding=True))
    where = " AND ".join(clauses)

    sql = text(f"""
        WITH pts AS (
            SELECT floor(ST_X(ST_LineInterpolatePoint(pr.geom, 0.5)) / :cell) * :cell AS x0,
                   floor(ST_Y(ST_LineInterpolatePoint(pr.geom, 0.5)) / :cell) * :cell AS y0,
                   a.{err} AS err
            FROM curated.intel_forecast_accuracy a
            JOIN curated.producing_reference pr ON pr.api10 = a.api10
            WHERE {where}
        ),
        cells AS (
            SELECT x0, y0, count(*) AS n, avg(err) AS bias, avg(abs(err)) AS mae
            FROM pts GROUP BY x0, y0
        )
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(jsonb_agg(
                jsonb_build_object(
                    'type', 'Feature',
                    'geometry', ST_AsGeoJSON(ST_MakeEnvelope(x0, y0, x0 + :cell, y0 + :cell, 4326))::jsonb,
                    'properties', jsonb_build_object(
                        'x0', x0, 'y0', y0, 'n', n,
                        'bias', round(bias::numeric, 4), 'mae', round(mae::numeric, 4)
                    )
                )), '[]'::jsonb)
        )::text
        FROM cells
    """)
    if expanding:
        sql = sql.bindparams(*expanding)
    fc = json.loads(session.execute(sql, params).scalar())
    return {
        "basin": basin, "stream": stream, "norm": norm, "horizon": horizon,
        "cell_deg": cell, "cell_count": len(fc["features"]), "cells": fc,
    }


# ---------------------------------------------------------------------------
# selection (lasso/box AOI -> aggregate forecast vs actual + member wells)
# ---------------------------------------------------------------------------
class SelectionBody(BaseModel):
    basin: Literal["delaware", "midland"]
    aoi: dict  # GeoJSON geometry (Polygon), same contract as /api/select
    rule: Literal["intersects", "midpoint"] = "intersects"


# AOI predicate against the drilled lateral (curated.producing_reference.geom)
# — same two rules as /api/select.
_SEL_PRED = {
    "intersects": "ST_Intersects(pr.geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(pr.geom, 0.5))",
}

_STREAMS: tuple[str, ...] = ("oil", "gas", "water")
_WELLS_CAP = 500


@router.post("/selection")
def selection(body: SelectionBody, session: Session = Depends(get_session)) -> dict:
    """Aggregate forecast-vs-actual for the blind wells inside a drawn AOI.

    Per stream and aligned month: the per-well MEAN of the per-ft cums (actual
    and forecast, both required non-null so the two curves cover the same well
    set at each mop) plus bias/MAE, and — for the direct-tier subset — SUMMED
    raw volumes (field total). is_latest_reported rows are excluded. n per mop
    declines as reporting lag censors the calendar tail; the client shows it.

    Also returns the member wells (capped at 500) with per-horizon per-ft
    errors for the drill-down table.
    """
    per_ft_aggs = ",\n".join(
        f"""count(*) FILTER (WHERE actual_cum_{s}_perft IS NOT NULL AND fcst_cum_{s}_perft IS NOT NULL) AS n_{s},
            avg(actual_cum_{s}_perft) FILTER (WHERE actual_cum_{s}_perft IS NOT NULL AND fcst_cum_{s}_perft IS NOT NULL) AS act_{s},
            avg(fcst_cum_{s}_perft)   FILTER (WHERE actual_cum_{s}_perft IS NOT NULL AND fcst_cum_{s}_perft IS NOT NULL) AS fc_{s},
            avg(pct_err_{s}_perft)      AS bias_{s},
            avg(abs(pct_err_{s}_perft)) AS mae_{s},
            count(*) FILTER (WHERE actual_cum_{s} IS NOT NULL AND fcst_cum_{s} IS NOT NULL) AS n_{s}_raw,
            sum(actual_cum_{s}) FILTER (WHERE actual_cum_{s} IS NOT NULL AND fcst_cum_{s} IS NOT NULL) AS act_{s}_raw,
            sum(fcst_cum_{s})   FILTER (WHERE actual_cum_{s} IS NOT NULL AND fcst_cum_{s} IS NOT NULL) AS fc_{s}_raw"""
        for s in _STREAMS
    )
    sel_cte = f"""
        WITH aoi AS (
            SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g
        ),
        sel AS (
            SELECT pr.api10
            FROM curated.producing_reference pr, aoi
            WHERE {_SEL_PRED[body.rule]}
              AND EXISTS (SELECT 1 FROM curated.intel_forecast_accuracy a
                          WHERE a.api10 = pr.api10 AND a.basin = :basin)
        )
    """
    params = {"aoi": json.dumps(body.aoi), "basin": body.basin}

    by_month_rows = session.execute(
        text(f"""
            {sel_cte}
            SELECT a.mop, {per_ft_aggs}
            FROM curated.intel_forecast_accuracy a
            JOIN sel ON sel.api10 = a.api10
            WHERE NOT a.is_latest_reported
            GROUP BY a.mop ORDER BY a.mop
        """),
        params,
    ).mappings().all()

    err_props = ",\n".join(
        f"max(pct_err_{s}_perft) FILTER (WHERE mop = {h} AND NOT is_latest_reported) AS err{h}_{s}_perft"
        for h in HORIZONS
        for s in _STREAMS
    )
    well_rows = session.execute(
        text(f"""
            {sel_cte}
            SELECT a.api10,
                   max(a.tier)              AS tier,
                   max(a.operator)          AS operator,
                   COALESCE(max(a.formation_blueox), '(unmapped)') AS formation_blueox,
                   max(a.mop)               AS n_months,
                   bool_or(a.low_n)         AS low_n,
                   {err_props}
            FROM curated.intel_forecast_accuracy a
            JOIN sel ON sel.api10 = a.api10
            GROUP BY a.api10
            ORDER BY a.api10
        """),
        params,
    ).mappings().all()

    def _f(v):
        return float(v) if v is not None else None

    by_month: dict = {}
    for s in _STREAMS:
        by_month[s] = {
            "mop": [int(r["mop"]) for r in by_month_rows],
            "n": [int(r[f"n_{s}"]) for r in by_month_rows],
            "actual_perft": [_f(r[f"act_{s}"]) for r in by_month_rows],
            "fcst_perft": [_f(r[f"fc_{s}"]) for r in by_month_rows],
            "bias": [_f(r[f"bias_{s}"]) for r in by_month_rows],
            "mae": [_f(r[f"mae_{s}"]) for r in by_month_rows],
            "n_raw": [int(r[f"n_{s}_raw"]) for r in by_month_rows],
            "actual_raw": [_f(r[f"act_{s}_raw"]) for r in by_month_rows],
            "fcst_raw": [_f(r[f"fc_{s}_raw"]) for r in by_month_rows],
        }

    wells = [
        {
            "api10": r["api10"], "tier": r["tier"], "operator": r["operator"],
            "formation_blueox": r["formation_blueox"],
            "n_months": int(r["n_months"]), "low_n": bool(r["low_n"]),
            **{
                f"err{h}_{s}_perft": _f(r[f"err{h}_{s}_perft"])
                for h in HORIZONS for s in _STREAMS
            },
        }
        for r in well_rows[:_WELLS_CAP]
    ]
    return {
        "basin": body.basin,
        "rule": body.rule,
        "well_count": len(well_rows),
        "direct_count": sum(1 for r in well_rows if r["tier"] == "direct"),
        "proxy_count": sum(1 for r in well_rows if r["tier"] == "proxy"),
        "truncated": len(well_rows) > _WELLS_CAP,
        "wells": wells,
        "by_month": by_month,
    }


# ---------------------------------------------------------------------------
# well (modal: series + neighborhood gunbarrel)
# ---------------------------------------------------------------------------
def _stream_series(rows, s: str) -> dict:
    def col(name):
        return [float(r[name]) if r[name] is not None else None for r in rows]

    return {
        "fcst_cum": col(f"fcst_cum_{s}"),
        "actual_cum": col(f"actual_cum_{s}"),
        "fcst_cum_perft": col(f"fcst_cum_{s}_perft"),
        "actual_cum_perft": col(f"actual_cum_{s}_perft"),
        "pct_err": col(f"pct_err_{s}"),
        "pct_err_perft": col(f"pct_err_{s}_perft"),
    }


@router.get("/well")
def well(api10: str = _API10, session: Session = Depends(get_session)) -> dict:
    """One well's forecast-vs-actual series + a gunbarrel.

    Gunbarrel frame is DSU-FIRST: the Novi DSU polygon (raw_novi_intel.pads)
    containing the subject's lateral midpoint defines the well set — every
    producing well and Novi PUD/RES stick whose midpoint falls in that unit
    (the same population rule as the Highgrade per-DSU gunbarrel; blind PDPs
    carry no pad_name, so containment is spatial). Falls back to a 1-mi
    radius when no pad polygon contains the well. The comparison sticks (the
    reconciled match(es) on the direct tier, the live representative set on
    the proxy tier — same SSOT selector and tolerances the matview used) are
    ALWAYS unioned in, even when they reach outside the unit — they are the
    forecast benchmark. Projection: lateral midpoints onto the axis
    perpendicular to the set's mean heel->toe direction — same math as
    /api/gunbarrel and /api/highgrade."""
    rows = session.execute(
        text("""
            SELECT * FROM curated.intel_forecast_accuracy
            WHERE api10 = :api10 ORDER BY mop
        """),
        {"api10": api10},
    ).mappings().all()
    if not rows:
        raise HTTPException(status_code=404, detail="api10 not in the accuracy population")
    meta = rows[0]
    tier = meta["tier"]
    basin = meta["basin"]

    # Comparison stick set.
    if tier == "direct":
        comp = session.execute(
            text("""
                SELECT stick_id FROM curated.reconciled_inventory
                WHERE matched_api10 = :api10
                  AND status IN ('realized_drift', 'realized_phantom')
            """),
            {"api10": api10},
        ).scalars().all()
    else:
        comp = session.execute(
            text("""
                SELECT r.stick_id
                FROM curated.producing_reference pr
                LEFT JOIN curated.formation_blueox_tvd t ON t.api10 = pr.api10
                CROSS JOIN LATERAL curated.intel_representative_sticks(
                    pr.geom, COALESCE(t.corrected_code, pr.code),
                    pr.ll_ft::float8, :radius, :tol) r
                WHERE pr.api10 = :api10
            """),
            {"api10": api10, "radius": _REP_RADIUS_M, "tol": _REP_TOL[basin]},
        ).scalars().all()
    comp_set = set(comp)

    # Frame: the Novi DSU containing the subject's lateral midpoint, if any.
    dsu_pad = session.execute(
        text("""
            SELECT p.pad_name
            FROM raw_novi_intel.pads p
            JOIN curated.producing_reference s ON s.api10 = :api10
            WHERE p.basin = :basin AND p.geom IS NOT NULL AND p.pad_name IS NOT NULL
              AND ST_Contains(p.geom, ST_LineInterpolatePoint(s.geom, 0.5))
            ORDER BY p.pad_id LIMIT 1
        """),
        {"api10": api10, "basin": basin},
    ).scalar()

    _PDP_COLS = """
            SELECT 'pdp' AS kind, pr.api10 AS well_key, NULL::bigint AS stick_id,
                   pr.operator, pr.code AS formation_blueox, 'PDP' AS category,
                   pr.tvd, pr.ll_ft,
                   ST_X(ST_LineInterpolatePoint(pr.geom, 0.5)) AS mx,
                   ST_Y(ST_LineInterpolatePoint(pr.geom, 0.5)) AS my,
                   ST_X(ST_StartPoint(pr.geom)) AS sx, ST_Y(ST_StartPoint(pr.geom)) AS sy,
                   ST_X(ST_EndPoint(pr.geom)) AS ex, ST_Y(ST_EndPoint(pr.geom)) AS ey
    """
    _STICK_COLS = """
            SELECT 'stick' AS kind, NULL AS well_key, il.stick_id,
                   il.operator, fb.formation_blueox, il.category,
                   il.tvd, il.ll_ft,
                   ST_X(ST_LineInterpolatePoint(il.wellstick_geom, 0.5)) AS mx,
                   ST_Y(ST_LineInterpolatePoint(il.wellstick_geom, 0.5)) AS my,
                   ST_X(ST_StartPoint(il.wellstick_geom)) AS sx,
                   ST_Y(ST_StartPoint(il.wellstick_geom)) AS sy,
                   ST_X(ST_EndPoint(il.wellstick_geom)) AS ex,
                   ST_Y(ST_EndPoint(il.wellstick_geom)) AS ey
    """

    if dsu_pad is not None:
        # DSU frame: midpoint containment against the pad polygon (GiST
        # ST_Intersects prefilter on the lateral geometries).
        context_sql = f"""
            WITH pad AS (
                SELECT geom FROM raw_novi_intel.pads
                WHERE basin = :basin AND pad_name = :pad_name AND geom IS NOT NULL
                ORDER BY pad_id LIMIT 1
            )
            {_PDP_COLS}
            FROM curated.producing_reference pr, pad
            WHERE ST_Intersects(pr.geom, pad.geom)
              AND ST_Contains(pad.geom, ST_LineInterpolatePoint(pr.geom, 0.5))
              AND pr.tvd IS NOT NULL
            UNION ALL
            {_STICK_COLS}
            FROM curated.intel_locations il
            LEFT JOIN curated.intel_formation_blueox fb ON fb.stick_id = il.stick_id,
                 pad
            WHERE il.category IN ('PUD', 'RES')
              AND il.wellstick_geom IS NOT NULL AND il.tvd IS NOT NULL
              AND ST_Intersects(il.wellstick_geom, pad.geom)
              AND ST_Contains(pad.geom, ST_LineInterpolatePoint(il.wellstick_geom, 0.5))
        """
        ctx_params: dict = {"basin": basin, "pad_name": dsu_pad}
    else:
        # Radius fallback: no DSU polygon contains the well. The geography
        # predicates ride the sql/26 expression indexes.
        context_sql = f"""
            WITH subject AS (
                SELECT geom FROM curated.producing_reference WHERE api10 = :api10
            )
            {_PDP_COLS}
            FROM curated.producing_reference pr
            JOIN curated.wells w ON w.api10 = pr.api10, subject
            WHERE ST_DWithin(w.wellstick_geom::geography, subject.geom::geography, :radius)
              AND pr.tvd IS NOT NULL
            UNION ALL
            {_STICK_COLS}
            FROM curated.intel_locations il
            LEFT JOIN curated.intel_formation_blueox fb ON fb.stick_id = il.stick_id,
                 subject
            WHERE il.category IN ('PUD', 'RES')
              AND il.wellstick_geom IS NOT NULL AND il.tvd IS NOT NULL
              AND ST_DWithin(il.wellstick_geom::geography, subject.geom::geography, :radius)
        """
        ctx_params = {"api10": api10, "radius": _REP_RADIUS_M}

    ws = list(session.execute(text(context_sql), ctx_params).mappings().all())

    # The comparison sticks are always in the chart, even outside the DSU —
    # they are the forecast benchmark. Same for the subject well itself
    # (containment can miss it on a NULL-tvd edge only).
    if comp_set:
        comp_sql = text(f"""
            {_STICK_COLS}
            FROM curated.intel_locations il
            LEFT JOIN curated.intel_formation_blueox fb ON fb.stick_id = il.stick_id
            WHERE il.stick_id IN :comp_ids
              AND il.wellstick_geom IS NOT NULL AND il.tvd IS NOT NULL
        """).bindparams(bindparam("comp_ids", expanding=True))
        ws += session.execute(comp_sql, {"comp_ids": list(comp_set)}).mappings().all()

    # Dedupe (a comparison stick inside the DSU appears in both arms).
    seen: set = set()
    deduped = []
    for w in ws:
        key = (w["kind"], w["well_key"], w["stick_id"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(w)
    ws = deduped

    # Perpendicular-axis projection (shared math; see module docstring).
    lat0 = sum(w["my"] for w in ws) / len(ws)
    lon0 = sum(w["mx"] for w in ws) / len(ws)
    k = math.cos(math.radians(lat0))

    def to_m(lon, lat):
        return ((lon - lon0) * M_PER_DEG_LON * k, (lat - lat0) * M_PER_DEG_LAT)

    dx = dy = 0.0
    mids = []
    for w in ws:
        sxm, sym = to_m(w["sx"], w["sy"])
        exm, eym = to_m(w["ex"], w["ey"])
        dx += exm - sxm
        dy += eym - sym
        mids.append(to_m(w["mx"], w["my"]))
    norm_len = math.hypot(dx, dy)
    perp = (1.0, 0.0) if norm_len < 1e-9 else (-(dy / norm_len), dx / norm_len)
    perp, axis_left, axis_right = _canonical_axis(perp)
    cx = sum(m[0] for m in mids) / len(mids)
    cy = sum(m[1] for m in mids) / len(mids)

    gb_wells = []
    for w, (mxm, mym) in zip(ws, mids):
        offset_ft = ((mxm - cx) * perp[0] + (mym - cy) * perp[1]) * FT_PER_M
        role = (
            "subject" if w["well_key"] == api10
            else "comparison" if w["stick_id"] in comp_set
            else "context"
        )
        gb_wells.append({
            "role": role, "kind": w["kind"],
            "api10": w["well_key"], "stick_id": w["stick_id"],
            "category": w["category"], "formation_blueox": w["formation_blueox"],
            "operator": w["operator"],
            "tvd": float(w["tvd"]),
            "ll_ft": float(w["ll_ft"]) if w["ll_ft"] is not None else None,
            "offset_ft": round(offset_ft, 1),
        })
    gb_wells.sort(key=lambda x: x["offset_ft"])

    def _f(v):
        return float(v) if v is not None else None

    return {
        "api10": api10,
        "tier": tier,
        "basin": basin,
        "formation_blueox": meta["formation_blueox"],
        "operator": meta["operator"],
        "pad_name": meta["pad_name"],
        "first_prod": meta["first_production_date"].isoformat(),
        "drilled_ll_ft": _f(meta["drilled_ll_ft"]),
        "novi_ll_ft": _f(meta["novi_ll_ft"]),
        "rep_median_ll_ft": _f(meta["rep_median_ll_ft"]),
        "ll_ratio": _f(meta["ll_ratio"]),
        "match_overlap": _f(meta["match_overlap"]),
        "n_sticks_for_well": meta["n_sticks_for_well"],
        "n_rep": meta["n_rep"],
        "low_n": bool(meta["low_n"]),
        "series": {
            "mop": [int(r["mop"]) for r in rows],
            "is_latest_reported": [bool(r["is_latest_reported"]) for r in rows],
            "producing_day_frac": [_f(r["producing_day_frac"]) for r in rows],
            "oil": _stream_series(rows, "oil"),
            "gas": _stream_series(rows, "gas"),
            "water": _stream_series(rows, "water"),
        },
        "gunbarrel": {
            "frame": "dsu" if dsu_pad is not None else "radius",
            "frame_pad_name": dsu_pad,
            "well_count": len(gb_wells),
            "axis_left": axis_left, "axis_right": axis_right,
            "wells": gb_wells,
        },
    }
