"""Vector tiles for the erebor map, rendered server-side by PostGIS from
curated.erebor_locations (PUD/RES = the Novi location universe; PDP = curated
producing horizontals — see sql/22 in engineering_db) with the BOX record run's
per-location projection joined on (app.box_locations — the one module that reads
BOX attributes).

  * z <= 8  -> intel_points  (lateral heel point, cheap at low zoom)
  * z >= 9  -> intel_lines   (full wellstick LINESTRING)

basin is required (the map shows one basin at a time). Every category ships in
every tile; the frontend filters client-side (no refetch). Novi supplies only the
stick geometry: `category` is PDP | LOCATION (Novi's PUD / RES tag is not shipped).
BOX properties per stick: `coverage` (NULL on PDP — producing context, never
forecast; app.box_locations.map_coverage_sql), `water_tier`, `oil_eur_ft` / `gas_eur_ft` / `water_eur_ft` (per FOOT),
`prox_outcome`, `prox_factor` (only when < 1). A not-covered stick has no EUR
property at all (MVT omits NULLs) — never a zero.

`econ` (optional, `?econ=<metric>&deck=<deck_id>`): ONE of Steven's whitelisted
columns for the RECORD run's priced case (display-only, D13). An unpriced run
leaves the property off every stick; the econ legend says "not yet priced".
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.box_locations import ECON_METRICS, box_joins, econ_case, econ_join, record_run_id, tile_columns
from app.db import get_session

router = APIRouter(prefix="/tiles", tags=["tiles"])

POINTS_MAX_Z = 8
MVT_CONTENT_TYPE = "application/vnd.mapbox-vector-tile"

_GEOM = {"points": "ST_StartPoint(w.wellstick_geom)", "lines": "w.wellstick_geom"}
_ECON_PATTERN = "^(" + "|".join(ECON_METRICS) + ")$"


def _mvt_sql(kind: str, econ_metric: str | None) -> str:
    layer = "intel_points" if kind == "points" else "intel_lines"
    geom_expr = _GEOM[kind]
    return f"""
WITH bounds AS (SELECT ST_TileEnvelope(:z, :x, :y) AS env)
, mvtgeom AS (
  SELECT
    w.stick_id,
    w.unique_id,
    -- PDP vs a Novi stick location; Novi's own PUD / RES tag is not shipped (only the
    -- stick geometry comes from Novi — classification is BOX's `coverage`).
    CASE WHEN w.category = 'PDP' THEN 'PDP' ELSE 'LOCATION' END AS category,
    w.formation_blueox,
    w.basin_blueox,
    w.operator,
    w.ll_ft,
    {tile_columns("w", econ_metric)},
    ST_AsMVTGeom(
      ST_Transform({geom_expr}, 3857),
      (SELECT env FROM bounds), 4096, 64, true
    ) AS geom
  FROM curated.erebor_locations w
  {box_joins("w", bench="w.formation_blueox")}
  {econ_join() if econ_metric is not None else ""}
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
    econ: str | None = Query(None, pattern=_ECON_PATTERN),
    deck: str | None = Query(None, max_length=64),
    session: Session = Depends(get_session),
) -> Response:
    if x >= (1 << z) or y >= (1 << z):
        raise HTTPException(status_code=400, detail="tile coords out of range for z")
    kind = "points" if z <= POINTS_MAX_Z else "lines"
    run_id = record_run_id(session)
    case = econ_case(session, run_id, deck) if (econ and run_id is not None) else None
    econ_metric = econ if case is not None else None
    params = {"z": z, "x": x, "y": y, "basin": basin, "box_run": run_id,
              "econ_deck": case["deck_id"] if case else None,
              "econ_aset": case["assumption_set_id"] if case else None}
    result = session.execute(text(_mvt_sql(kind, econ_metric)), params).scalar()
    payload = bytes(result) if result is not None else b""
    if not payload:
        return Response(status_code=204, headers={"Cache-Control": "public, max-age=60"})
    return Response(
        content=payload,
        media_type=MVT_CONTENT_TYPE,
        headers={"Cache-Control": "public, max-age=60"},
    )
