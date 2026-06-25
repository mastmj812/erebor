"""Gunbarrel cross-section data for an AOI selection.

Per pad, project each lateral's midpoint onto the axis PERPENDICULAR to the pad's
mean lateral azimuth (horizontal offset, ft) and pair it with TVD — the classic
gunbarrel view looking down the laterals. Markers carry formation for coloring.

Uses wellstick_geom (present for all categories). Restricted to real DSU pads
(PDP's placeholder pad names are excluded).
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(prefix="/gunbarrel", tags=["gunbarrel"])

Rule = Literal["intersects", "midpoint"]
_PRED = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(w.wellstick_geom, 0.5))",
}
M_PER_DEG_LAT = 110540.0
M_PER_DEG_LON = 111320.0
FT_PER_M = 3.28084
MAX_PADS = 24


class GbBody(BaseModel):
    aoi: dict
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"


@router.post("")
def gunbarrel(body: GbBody, session: Session = Depends(get_session)) -> dict:
    pred = _PRED[body.rule]
    # PUD/RES carry a real pad_name; PDP's is a placeholder, so resolve its pad by
    # spatially containing its lateral midpoint in a DSU pad polygon. Wells with no
    # real pad and no containing polygon are dropped (can't place on a pad).
    rows = session.execute(
        text(f"""
            WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g),
            sel AS (
              SELECT w.stick_id, w.unique_id, w.category, UPPER(w.formation) AS formation,
                     fb.formation_blueox, fb.basin_blueox, fb.formation_blueox_source,
                     w.tvd, w.ll_ft, w.wellstick_geom AS geom,
                     ST_LineInterpolatePoint(w.wellstick_geom, 0.5) AS mid,
                     CASE WHEN w.pad_name IS NULL OR w.pad_name IN ('PDP', 'No Pad Name')
                          THEN NULL ELSE w.pad_name END AS real_pad
              FROM curated.intel_locations w
              LEFT JOIN curated.intel_formation_blueox fb ON fb.stick_id = w.stick_id,
                   aoi
              WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL
                AND w.tvd IS NOT NULL AND {pred}
            )
            SELECT sel.stick_id, sel.unique_id, sel.category, sel.formation,
                   sel.formation_blueox, sel.basin_blueox, sel.formation_blueox_source,
                   sel.tvd, sel.ll_ft,
                   COALESCE(sel.real_pad, p.pad_name) AS pad_name,
                   ST_X(sel.mid) AS mx, ST_Y(sel.mid) AS my,
                   ST_X(ST_StartPoint(sel.geom)) AS sx, ST_Y(ST_StartPoint(sel.geom)) AS sy,
                   ST_X(ST_EndPoint(sel.geom))   AS ex, ST_Y(ST_EndPoint(sel.geom))   AS ey
            FROM sel
            LEFT JOIN LATERAL (
              SELECT p.pad_name FROM raw_novi_intel.pads p
              WHERE p.basin = :basin AND sel.real_pad IS NULL
                AND ST_Contains(p.geom, sel.mid)
              LIMIT 1
            ) p ON true
            WHERE COALESCE(sel.real_pad, p.pad_name) IS NOT NULL
        """),
        {"aoi": json.dumps(body.aoi), "basin": body.basin},
    ).mappings().all()

    by_pad: dict[str, list] = defaultdict(list)
    for r in rows:
        by_pad[r["pad_name"]].append(r)

    pads_out = []
    for pad, ws in by_pad.items():
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
        if norm < 1e-9:
            perp = (1.0, 0.0)
        else:
            ux, uy = dx / norm, dy / norm
            perp = (-uy, ux)  # rotate lateral direction 90deg
        cx = sum(m[0] for m in mids) / len(mids)
        cy = sum(m[1] for m in mids) / len(mids)

        wells = []
        for w, (mxm, mym) in zip(ws, mids):
            offset_ft = ((mxm - cx) * perp[0] + (mym - cy) * perp[1]) * FT_PER_M
            wells.append({
                "stick_id": w["stick_id"],
                "unique_id": w["unique_id"], "category": w["category"],
                "formation": w["formation"],
                "formation_blueox": w["formation_blueox"],
                "basin_blueox": w["basin_blueox"],
                "formation_blueox_source": w["formation_blueox_source"],
                "tvd": float(w["tvd"]),
                "ll_ft": float(w["ll_ft"]) if w["ll_ft"] is not None else None,
                "offset_ft": round(offset_ft, 1),
            })
        wells.sort(key=lambda x: x["offset_ft"])
        pads_out.append({"pad_name": pad, "well_count": len(wells), "wells": wells})

    pads_out.sort(key=lambda p: -p["well_count"])
    return {"pad_count": len(pads_out), "pads": pads_out[:MAX_PADS]}
