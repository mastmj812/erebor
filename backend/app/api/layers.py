"""GeoJSON overlays + basin metadata for the map.

Pads (~4.5k) and the basin outline are served whole. The land grid (~20k
polygons) is lightly simplified to keep the payload reasonable; it's an
overlay, not the analytic layer.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(tags=["layers"])
GEOJSON = "application/geo+json"
_BASIN = Query(..., pattern="^(delaware|midland)$")


def _fc(session: Session, inner_sql: str, params: dict) -> Response:
    sql = f"""
SELECT COALESCE(
  json_build_object(
    'type','FeatureCollection',
    'features', COALESCE(json_agg(ST_AsGeoJSON(t.*)::json), '[]'::json)
  )::text, '{{"type":"FeatureCollection","features":[]}}')
FROM ({inner_sql}) t
"""
    body = session.execute(text(sql), params).scalar()
    return Response(content=body, media_type=GEOJSON,
                    headers={"Cache-Control": "public, max-age=300"})


@router.get("/layers/pads.geojson")
def pads(basin: str = _BASIN, session: Session = Depends(get_session)) -> Response:
    return _fc(
        session,
        "SELECT pad_name, npv25 AS pad_npv25, geom FROM raw_novi_intel.pads "
        "WHERE basin = :basin AND geom IS NOT NULL",
        {"basin": basin},
    )


@router.get("/layers/land_grid.geojson")
def land_grid(basin: str = _BASIN, session: Session = Depends(get_session)) -> Response:
    return _fc(
        session,
        "SELECT grid_id, attrs, ST_SimplifyPreserveTopology(geom, 0.0003) AS geom "
        "FROM raw_novi_intel.land_grid WHERE basin = :basin AND geom IS NOT NULL",
        {"basin": basin},
    )


@router.get("/layers/outline.geojson")
def outline(basin: str = _BASIN, session: Session = Depends(get_session)) -> Response:
    return _fc(
        session,
        "SELECT outline_id, geom FROM raw_novi_intel.basin_outline "
        "WHERE basin = :basin AND geom IS NOT NULL",
        {"basin": basin},
    )


@router.get("/basins")
def basins(session: Session = Depends(get_session)) -> list[dict]:
    """Per-basin stick counts + bbox (for the basin switcher and map fit).

    Counts the same sticks the tiles render (curated.erebor_locations), so the
    label under the basin switcher matches the map — PDP here is curated
    producing horizontals, not the novi_intel PDP layer.
    """
    rows = session.execute(text("""
        SELECT basin, n,
               ST_XMin(e) AS minx, ST_YMin(e) AS miny,
               ST_XMax(e) AS maxx, ST_YMax(e) AS maxy
        FROM (
          SELECT basin, count(*) AS n, ST_Extent(wellstick_geom) AS e
          FROM curated.erebor_locations GROUP BY basin
        ) s
        ORDER BY basin
    """)).mappings().all()
    return [
        {
            "basin": r["basin"],
            "count": int(r["n"]),
            "bbox": [r["minx"], r["miny"], r["maxx"], r["maxy"]],
        }
        for r in rows
    ]


@router.get("/recon_counts")
def recon_counts(basin: str = _BASIN, session: Session = Depends(get_session)) -> dict[str, int]:
    """§6 reconciliation-status stick counts for the basin (legend annotations).

    Counts the same map sticks the tiles render (curated.erebor_locations);
    NULL recon_status (RES / ordinary producers) is keyed '(null)' to match the
    frontend RECON_STATUS legend entry.
    """
    rows = session.execute(text("""
        SELECT COALESCE(recon_status, '(null)') AS status, count(*) AS n
        FROM curated.erebor_locations
        WHERE basin = :basin AND wellstick_geom IS NOT NULL
        GROUP BY 1
    """), {"basin": basin}).mappings().all()
    return {r["status"]: int(r["n"]) for r in rows}


@router.get("/depletion_counts")
def depletion_counts(basin: str = _BASIN, session: Session = Depends(get_session)) -> dict[str, int]:
    """Novi depletion-tier stick counts for the basin (legend annotations).

    Counts the same map sticks the tiles render (curated.erebor_locations);
    NULL deplet_t (PDP / RES — unscored) is keyed '(null)' to match the frontend
    DEPLETION_TIERS legend entry.
    """
    rows = session.execute(text("""
        SELECT COALESCE(deplet_t, '(null)') AS tier, count(*) AS n
        FROM curated.erebor_locations
        WHERE basin = :basin AND wellstick_geom IS NOT NULL
        GROUP BY 1
    """), {"basin": basin}).mappings().all()
    return {r["tier"]: int(r["n"]) for r in rows}


@router.get("/support_counts")
def support_counts(basin: str = _BASIN, session: Session = Depends(get_session)) -> dict[str, int]:
    """Offset-PDP support bucket counts for the basin (support-mode legend).

    Unlike recon/depletion counts, this covers ONLY the SCORED population
    (PUD/RES) — PDP is not scored, so counting it would swamp the legend with a
    huge '(null)' bucket. Buckets match the frontend SUPPORT_TIERS keys
    (pdp_count_3mi: 0 / 1–2 / 3–7 / 8+); unscorable (NULL) is keyed '(null)'.
    """
    rows = session.execute(text("""
        SELECT CASE
                 WHEN pdp_count_3mi IS NULL THEN '(null)'
                 WHEN pdp_count_3mi = 0     THEN '0'
                 WHEN pdp_count_3mi <= 2    THEN '1'
                 WHEN pdp_count_3mi <= 7    THEN '3'
                 ELSE '8'
               END AS bucket, count(*) AS n
        FROM curated.erebor_locations
        WHERE basin = :basin AND category IN ('PUD', 'RES')
          AND wellstick_geom IS NOT NULL
        GROUP BY 1
    """), {"basin": basin}).mappings().all()
    return {r["bucket"]: int(r["n"]) for r in rows}
