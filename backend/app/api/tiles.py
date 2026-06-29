"""Vector tiles for the erebor map, rendered server-side by PostGIS from
curated.intel_locations.

  * z <= 8  -> intel_points  (lateral heel point, cheap at low zoom)
  * z >= 9  -> intel_lines   (full wellstick LINESTRING)

basin is required (the map shows one basin at a time). All three categories
(PDP/PUD/RES) ship in every tile as a `category` property; the frontend toggles
them with a client-side layer filter (no refetch). formation is emitted UPPER
so it matches the canonical strings in the frontend formation palette.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Path, Query, Response
from sqlalchemy import text
from sqlalchemy.orm import Session
from fastapi import Depends

from app.db import get_session

router = APIRouter(prefix="/tiles", tags=["tiles"])

POINTS_MAX_Z = 8
MVT_CONTENT_TYPE = "application/vnd.mapbox-vector-tile"

_GEOM = {"points": "ST_StartPoint(w.wellstick_geom)", "lines": "w.wellstick_geom"}


def _mvt_sql(kind: str) -> str:
    layer = "intel_points" if kind == "points" else "intel_lines"
    geom_expr = _GEOM[kind]
    return f"""
WITH bounds AS (SELECT ST_TileEnvelope(:z, :x, :y) AS env)
, mvtgeom AS (
  SELECT
    w.stick_id,
    w.unique_id,
    w.category,
    UPPER(w.formation) AS formation,
    w.formation_blueox,
    w.basin_blueox,
    w.recon_status,
    w.deplet_t,
    w.operator,
    w.npv25,
    w.oil_eur,
    w.ll_ft,
    ST_AsMVTGeom(
      ST_Transform({geom_expr}, 3857),
      (SELECT env FROM bounds), 4096, 64, true
    ) AS geom
  FROM curated.erebor_locations w
  WHERE w.basin = :basin
    AND w.wellstick_geom IS NOT NULL
    -- Intersect in the geometry's native SRID (4326) so the GiST index on
    -- wellstick_geom is usable. Transforming the *column* to 3857 (as
    -- ST_AsMVTGeom does for output) would force a per-row transform + seq scan;
    -- transforming the tile envelope back to 4326 keeps the index in play.
    AND ST_Intersects(w.wellstick_geom, ST_Transform((SELECT env FROM bounds), 4326))
)
SELECT ST_AsMVT(mvtgeom.*, '{layer}', 4096, 'geom')
FROM mvtgeom WHERE geom IS NOT NULL
"""


@router.get("/{z}/{x}/{y}.mvt")
def tile(
    z: int = Path(ge=0, le=22),
    x: int = Path(ge=0),
    y: int = Path(ge=0),
    basin: str = Query(..., pattern="^(delaware|midland)$"),
    session: Session = Depends(get_session),
) -> Response:
    if x >= (1 << z) or y >= (1 << z):
        raise HTTPException(status_code=400, detail="tile coords out of range for z")
    kind = "points" if z <= POINTS_MAX_Z else "lines"
    sql = _mvt_sql(kind)
    result = session.execute(text(sql), {"z": z, "x": x, "y": y, "basin": basin}).scalar()
    payload = bytes(result) if result is not None else b""
    if not payload:
        return Response(status_code=204, headers={"Cache-Control": "public, max-age=60"})
    return Response(
        content=payload,
        media_type=MVT_CONTENT_TYPE,
        headers={"Cache-Control": "public, max-age=60"},
    )
