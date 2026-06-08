"""AOI selection: return every Novi stick inside a drawn/uploaded polygon,
grouped by category / formation / pad.

Selection rule (toggleable — materially changes counts on depth-limited deals):
  * intersects : the lateral LINESTRING intersects the AOI  (ST_Intersects)
  * midpoint   : the lateral's midpoint falls inside the AOI (ST_Contains of
                 ST_LineInterpolatePoint(geom, 0.5))

Shapefile upload parses the deal .zip (pyshp), reprojects to EPSG:4326 (pyproj
from the .prj), and returns the AOI as a GeoJSON MultiPolygon — the frontend then
runs /select with it, the same path a drawn polygon takes.
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any, Literal

import shapefile  # pyshp
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from pyproj import CRS, Transformer
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_session

router = APIRouter(prefix="/select", tags=["select"])

Rule = Literal["intersects", "midpoint"]
MAX_STICKS = 20000  # deals are <5k acres; guard against a basin-wide AOI

_RULE_PREDICATE = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(w.wellstick_geom, 0.5))",
}


def select_in_aoi(
    session: Session, aoi_geom: dict, basin: str, rule: Rule
) -> dict[str, Any]:
    pred = _RULE_PREDICATE[rule]
    sql = text(f"""
        WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g)
        SELECT w.stick_id, w.unique_id, w.category, UPPER(w.formation) AS formation,
               w.pad_name, w.ll_ft,
               w.npv5, w.npv10, w.npv15, w.npv20, w.npv25,
               w.pv5, w.pv10, w.pv15, w.pv20, w.pv25,
               w.oil_eur, w.gas_eur,
               w.wti_price, w.hh_price, w.ngl_price, w.wti_diff, w.hh_diff
        FROM curated.intel_locations w, aoi
        WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL AND {pred}
    """)
    rows = session.execute(
        sql, {"aoi": json.dumps(aoi_geom), "basin": basin}
    ).mappings().all()

    truncated = len(rows) > MAX_STICKS
    use = rows[:MAX_STICKS]

    # Per-stick rows: the frontend computes the value rollup from these, applying
    # the formation filter AND the manual well-cull set, so both are instant.
    _COLS = (
        "stick_id", "unique_id", "category", "formation", "pad_name", "ll_ft",
        "npv5", "npv10", "npv15", "npv20", "npv25",
        "pv5", "pv10", "pv15", "pv20", "pv25", "oil_eur", "gas_eur",
    )
    sticks = [{c: r[c] for c in _COLS} for r in use]

    deck = use[0] if use else {}
    distinct_decks = len({
        (r["wti_price"], r["hh_price"], r["ngl_price"], r["wti_diff"], r["hh_diff"])
        for r in use
    })

    return {
        "basin": basin,
        "rule": rule,
        "count": len(use),
        "truncated": truncated,
        "price_deck": {
            "wti_price": deck.get("wti_price"),
            "hh_price": deck.get("hh_price"),
            "ngl_price": deck.get("ngl_price"),
            "wti_diff": deck.get("wti_diff"),
            "hh_diff": deck.get("hh_diff"),
            "distinct_decks": distinct_decks,
        },
        "sticks": sticks,
    }


class SelectBody(BaseModel):
    aoi: dict  # GeoJSON geometry (Polygon/MultiPolygon), EPSG:4326
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"


@router.post("")
def select(body: SelectBody, session: Session = Depends(get_session)) -> dict:
    return select_in_aoi(session, body.aoi, body.basin, body.rule)


# ---------------------------------------------------------------------------
# Shapefile upload -> reproject -> AOI MultiPolygon (then run selection)
# ---------------------------------------------------------------------------
def _shapefile_zip_to_aoi(data: bytes) -> dict:
    """Parse a deal shapefile .zip into a GeoJSON MultiPolygon in EPSG:4326."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = z.namelist()
        shp = next((n for n in names if n.lower().endswith(".shp")), None)
        if not shp:
            raise HTTPException(400, "No .shp found in the uploaded zip.")
        stem = shp[:-4].lower()

        def member(ext: str) -> io.BytesIO | None:
            for n in names:
                if n.lower() == stem + ext:
                    return io.BytesIO(z.read(n))
            return None

        prj = member(".prj")
        src_crs = CRS.from_wkt(prj.read().decode("utf-8", "replace")) if prj else CRS.from_epsg(4326)
        transformer = Transformer.from_crs(src_crs, CRS.from_epsg(4326), always_xy=True)
        reader = shapefile.Reader(shp=member(".shp"), dbf=member(".dbf"), shx=member(".shx"))

        def reproj_ring(ring: list) -> list:
            return [list(transformer.transform(x, y)) for x, y in ring]

        polygons: list = []
        for shprec in reader.iterShapes():
            gj = shprec.__geo_interface__
            if gj["type"] == "Polygon":
                polygons.append([reproj_ring(r) for r in gj["coordinates"]])
            elif gj["type"] == "MultiPolygon":
                for poly in gj["coordinates"]:
                    polygons.append([reproj_ring(r) for r in poly])

    if not polygons:
        raise HTTPException(400, "Shapefile contains no polygon geometry.")
    return {"type": "MultiPolygon", "coordinates": polygons}


@router.post("/shapefile")
async def select_shapefile(
    file: UploadFile = File(...),
    basin: Literal["delaware", "midland"] = Form(...),
    rule: Rule = Form("intersects"),
    session: Session = Depends(get_session),
) -> dict:
    aoi = _shapefile_zip_to_aoi(await file.read())
    result = select_in_aoi(session, aoi, basin, rule)
    result["aoi"] = aoi
    return result
