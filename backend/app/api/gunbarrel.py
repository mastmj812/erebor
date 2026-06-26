"""Gunbarrel cross-section data for an AOI selection.

Projects EVERY selected lateral onto ONE shared axis perpendicular to the
selection's mean lateral azimuth (horizontal offset, ft) and pairs it with TVD —
the classic gunbarrel view looking down the laterals, as a single cross-section.

A single shared frame (not one panel per Novi pad/unit) is deliberate: Novi names
PUDs per planned well and buckets producers into pad polygons, so trellising by
that assignment scatters physically co-located wells across panels — exactly the
wells the §6 reconciliation matches ACROSS unit names. One frame puts a producer
and the PUDs it overlaps side by side.

Assumes the selection is roughly parallel laterals (one azimuth) — true for a
box/lasso over a development area; a selection spanning two differently-oriented
areas will skew the offset. Uses wellstick_geom (present for all categories);
no pad resolution, so no well is dropped.
"""

from __future__ import annotations

import json
import math
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


class GbBody(BaseModel):
    aoi: dict
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"


@router.post("")
def gunbarrel(body: GbBody, session: Session = Depends(get_session)) -> dict:
    pred = _PRED[body.rule]
    rows = session.execute(
        text(f"""
            WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g)
            SELECT w.stick_id, w.unique_id, w.category, UPPER(w.formation) AS formation,
                   w.formation_blueox, w.basin_blueox, w.formation_blueox_source,
                   w.recon_status,
                   w.tvd, w.ll_ft,
                   ST_X(ST_LineInterpolatePoint(w.wellstick_geom, 0.5)) AS mx,
                   ST_Y(ST_LineInterpolatePoint(w.wellstick_geom, 0.5)) AS my,
                   ST_X(ST_StartPoint(w.wellstick_geom)) AS sx, ST_Y(ST_StartPoint(w.wellstick_geom)) AS sy,
                   ST_X(ST_EndPoint(w.wellstick_geom))   AS ex, ST_Y(ST_EndPoint(w.wellstick_geom))   AS ey
            FROM curated.erebor_locations w, aoi
            WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL
              AND w.tvd IS NOT NULL AND {pred}
        """),
        {"aoi": json.dumps(body.aoi), "basin": body.basin},
    ).mappings().all()

    if not rows:
        return {"pad_count": 0, "pads": []}

    # One frame for the whole selection: shared centroid + a single offset axis
    # perpendicular to the mean heel->toe azimuth.
    lat0 = sum(r["my"] for r in rows) / len(rows)
    lon0 = sum(r["mx"] for r in rows) / len(rows)
    k = math.cos(math.radians(lat0))

    def to_m(lon, lat):
        return ((lon - lon0) * M_PER_DEG_LON * k, (lat - lat0) * M_PER_DEG_LAT)

    dx = dy = 0.0
    mids = []
    for r in rows:
        sxm, sym = to_m(r["sx"], r["sy"])
        exm, eym = to_m(r["ex"], r["ey"])
        dx += exm - sxm
        dy += eym - sym
        mids.append(to_m(r["mx"], r["my"]))
    norm = math.hypot(dx, dy)
    if norm < 1e-9:
        perp = (1.0, 0.0)
    else:
        ux, uy = dx / norm, dy / norm
        perp = (-uy, ux)  # rotate the mean lateral direction 90deg
    cx = sum(m[0] for m in mids) / len(mids)
    cy = sum(m[1] for m in mids) / len(mids)

    wells = []
    for r, (mxm, mym) in zip(rows, mids):
        offset_ft = ((mxm - cx) * perp[0] + (mym - cy) * perp[1]) * FT_PER_M
        wells.append({
            "stick_id": r["stick_id"],
            "unique_id": r["unique_id"], "category": r["category"],
            "formation": r["formation"],
            "formation_blueox": r["formation_blueox"],
            "basin_blueox": r["basin_blueox"],
            "formation_blueox_source": r["formation_blueox_source"],
            "recon_status": r["recon_status"],
            "tvd": float(r["tvd"]),
            "ll_ft": float(r["ll_ft"]) if r["ll_ft"] is not None else None,
            "offset_ft": round(offset_ft, 1),
        })
    wells.sort(key=lambda x: x["offset_ft"])
    pad = {"pad_name": "Selection", "well_count": len(wells), "wells": wells}
    return {"pad_count": 1, "pads": [pad]}
