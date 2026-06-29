"""Production profiles for an AOI selection.

  * POST /production/aggregate : per-formation streams (oil/gas/water), summed over
    the selected wells, stitched Novi forecast (0 -> ~29.5 yr) + Arps tail
    (~29.5 -> 50 yr). well_count lets the frontend show per-well averages.
  * GET  /production/well      : one well's forecast stream + Arps tail to 50 yr.

Forecast/Arps are keyed by novi_wellname (= PUD/RES Unique ID). PDP sticks are
API-keyed and absent from the Novi forecast, so they don't contribute here (their
actuals live in curated.production — a later addition if wanted).
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_session
from decline.models import arps_exponential, arps_hyperbolic

router = APIRouter(prefix="/production", tags=["production"])

Rule = Literal["intersects", "midpoint"]
_PRED = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(w.wellstick_geom, 0.5))",
}
HORIZON_DAY = 18250  # 50 yr
STEP = 30


def _tail_values(segs: list, days_arr: np.ndarray) -> np.ndarray:
    """Vectorized rate at each tail day, using whichever segment covers it.

    `d_nom` is nominal decline per year; t is years since the segment start.
    decline.models functions are numpy-vectorized, so we evaluate a whole
    segment's day-slice at once. Days covered by no segment stay 0.
    """
    out = np.zeros(days_arr.shape, dtype=float)
    for seg in segs:
        mask = (days_arr >= seg["day_start"]) & (days_arr <= seg["day_stop"])
        if not mask.any():
            continue
        t = (days_arr[mask] - seg["day_start"]) / 365.0
        qi = float(seg["q_start"] or 0.0)
        di = float(seg["d_nom"] or 0.0)
        b = float(seg["b"] or 0.0)
        if seg["segment_curve_type"] == "exponential" or b < 1e-6:
            out[mask] = arps_exponential(t, qi, di)
        else:
            out[mask] = arps_hyperbolic(t, qi, di, b)
    return out


class AggBody(BaseModel):
    aoi: dict
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"
    exclude: list[str] = []  # manually-culled well names (unique_id) to drop


def _sel_cte(pred: str) -> str:
    # The curve rollup dimension is the Blue Ox bench (formation_blueox), matching
    # the map sticks and the ResultsPanel cull list (both keyed on the bench code).
    # NULL -> '(unmapped)' to mirror ResultsPanel, so its cull checkboxes line up
    # with these curves. Sourced from curated.erebor_locations (the only relation
    # carrying formation_blueox alongside unique_id / wellstick_geom).
    return f"""
        WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g),
        sel AS (
          SELECT w.unique_id, COALESCE(w.formation_blueox, '(unmapped)') AS formation
          FROM curated.erebor_locations w, aoi
          WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL AND {pred}
            AND w.unique_id <> ALL((:exclude)::text[])
        )
    """


@router.post("/aggregate")
def aggregate(body: AggBody, session: Session = Depends(get_session)) -> dict:
    pred = _PRED[body.rule]
    params = {"aoi": json.dumps(body.aoi), "basin": body.basin, "exclude": body.exclude}

    # 1) forecast (ML stream) summed per (formation, ip_day) -> ~29.5 yr
    fc_rows = session.execute(
        text(_sel_cte(pred) + """
            SELECT sel.formation, f.ip_day,
                   SUM(f.oil) AS oil, SUM(f.gas) AS gas, SUM(f.water) AS water,
                   COUNT(*) AS n
            FROM sel JOIN curated.intel_forecast f
              ON f.basin = :basin AND f.novi_wellname = sel.unique_id
            GROUP BY sel.formation, f.ip_day
            ORDER BY sel.formation, f.ip_day
        """),
        params,
    ).mappings().all()

    # 2) Arps segments per selected well (for the tail beyond the forecast)
    arps_rows = session.execute(
        text(_sel_cte(pred) + """
            SELECT sel.unique_id, sel.formation, a.production_stream,
                   a.segment_curve_type, a.b, a.d_nom, a.q_start, a.day_start, a.day_stop
            FROM sel JOIN curated.intel_arps a
              ON a.basin = :basin AND a.novi_wellname = sel.unique_id
        """),
        params,
    ).mappings().all()

    fc_days = sorted({r["ip_day"] for r in fc_rows})
    last_day = fc_days[-1] if fc_days else 0
    tail_days = list(range(int(last_day) + STEP, HORIZON_DAY + 1, STEP))
    ip_days = fc_days + tail_days
    n = len(ip_days)
    fidx = {d: i for i, d in enumerate(fc_days)}

    def blank(formation: str) -> dict:
        return {
            "formation": formation, "well_count": 0,
            "oil": [0.0] * n, "gas": [0.0] * n, "water": [0.0] * n,
        }

    forms: dict[str, dict] = {}
    for r in fc_rows:
        g = forms.setdefault(r["formation"], blank(r["formation"]))
        i = fidx[r["ip_day"]]
        g["oil"][i] = float(r["oil"] or 0.0)
        g["gas"][i] = float(r["gas"] or 0.0)
        g["water"][i] = float(r["water"] or 0.0)
        g["well_count"] = max(g["well_count"], int(r["n"]))

    # Arps tail: sum each well's segment-evaluated tail into its formation (numpy).
    base, nt = len(fc_days), len(tail_days)
    tail_arr = np.asarray(tail_days, dtype=float)
    segs_by: dict[tuple, list] = defaultdict(list)
    for r in arps_rows:
        segs_by[(r["formation"], r["unique_id"], r["production_stream"])].append(r)
    ftail: dict[str, dict[str, np.ndarray]] = {}
    for (formation, _uid, stream), segs in segs_by.items():
        if stream not in ("oil", "gas", "water"):
            continue
        ft = ftail.setdefault(
            formation, {"oil": np.zeros(nt), "gas": np.zeros(nt), "water": np.zeros(nt)}
        )
        ft[stream] += _tail_values(segs, tail_arr)
    for formation, ft in ftail.items():
        g = forms.setdefault(formation, blank(formation))
        for stream in ("oil", "gas", "water"):
            tv = ft[stream]
            for k in range(nt):
                g[stream][base + k] += float(tv[k])

    return {"ip_days": ip_days, "forecast_end_day": last_day, "formations": list(forms.values())}


@router.get("/well")
def well(
    name: str = Query(...),
    basin: Literal["delaware", "midland"] = Query(...),
    session: Session = Depends(get_session),
) -> dict:
    """One well's forecast stream + the Arps tail evaluated to 50 yr."""
    fc = session.execute(
        text("""
            SELECT ip_day, oil, gas, water FROM curated.intel_forecast
            WHERE basin = :basin AND novi_wellname = :name ORDER BY ip_day
        """),
        {"basin": basin, "name": name},
    ).mappings().all()
    forecast = {
        "ip_day": [r["ip_day"] for r in fc],
        "oil": [float(r["oil"] or 0) for r in fc],
        "gas": [float(r["gas"] or 0) for r in fc],
        "water": [float(r["water"] or 0) for r in fc],
    }
    last_day = fc[-1]["ip_day"] if fc else 0

    segs = session.execute(
        text("""
            SELECT production_stream, segment_curve_type, b, d_nom, q_start, day_start, day_stop
            FROM curated.intel_arps
            WHERE basin = :basin AND novi_wellname = :name
            ORDER BY production_stream, segment
        """),
        {"basin": basin, "name": name},
    ).mappings().all()
    by_stream: dict[str, list] = defaultdict(list)
    for s in segs:
        by_stream[s["production_stream"]].append(s)

    tail_days = list(range(int(last_day) + STEP, HORIZON_DAY + 1, STEP))
    tail_arr = np.asarray(tail_days, dtype=float)
    tail = {
        "ip_day": tail_days,
        "oil": _tail_values(by_stream.get("oil", []), tail_arr).tolist(),
        "gas": _tail_values(by_stream.get("gas", []), tail_arr).tolist(),
        "water": _tail_values(by_stream.get("water", []), tail_arr).tolist(),
    }
    return {
        "name": name, "forecast": forecast,
        "forecast_end_day": last_day, "arps_tail": tail,
        "has_forecast": len(fc) > 0,
    }
