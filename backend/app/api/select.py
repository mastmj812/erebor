"""AOI selection: return every stick inside a drawn polygon, grouped by
category / formation / pad.

Reads curated.erebor_locations — the SAME spine the map tiles render — so the
selection matches what's on screen: PUD/RES are Novi inventory, PDP is producing
curated horizontals (stick_id = -(api10), Novi econ columns NULL).

Selection rule (toggleable — materially changes counts on depth-limited deals):
  * intersects : the lateral LINESTRING intersects the AOI  (ST_Intersects)
  * midpoint   : the lateral's midpoint falls inside the AOI (ST_Contains of
                 ST_LineInterpolatePoint(geom, 0.5))

Shapefile upload (/select/deals) parses the deal .zip (pyshp), reprojects to
EPSG:4326 (pyproj from the .prj), and returns each polygon for DISPLAY only —
selection is always an explicit lasso/box draw by the user.
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any, Literal

import shapefile  # pyshp
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
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
    # formation_blueox / recon_status are baked into the matview — no joins.
    sql = text(f"""
        WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g)
        SELECT w.stick_id, w.unique_id, w.category, UPPER(w.formation) AS formation,
               w.formation_blueox,
               w.recon_status, w.deplet_t,
               w.pad_name, w.ll_ft,
               w.npv5, w.npv10, w.npv15, w.npv20, w.npv25,
               w.pv5, w.pv10, w.pv15, w.pv20, w.pv25,
               w.oil_eur, w.gas_eur,
               w.wti_price, w.hh_price, w.ngl_price, w.wti_diff, w.hh_diff
        FROM curated.erebor_locations w, aoi
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
        "stick_id", "unique_id", "category", "formation", "formation_blueox",
        "recon_status", "deplet_t", "pad_name", "ll_ft",
        "npv5", "npv10", "npv15", "npv20", "npv25",
        "pv5", "pv10", "pv15", "pv20", "pv25", "oil_eur", "gas_eur",
    )
    sticks = [{c: r[c] for c in _COLS} for r in use]

    # PDP rows (curated producers) carry a NULL deck — derive the deck from the
    # Novi PUD/RES rows only so an AOI whose first row is a producer still
    # reports the screen's price assumptions.
    decked = [r for r in use if r["wti_price"] is not None]
    deck = decked[0] if decked else {}
    distinct_decks = len({
        (r["wti_price"], r["hh_price"], r["ngl_price"], r["wti_diff"], r["hh_diff"])
        for r in decked
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
# Deals shapefile upload: return each polygon (reprojected) for map display.
# No selection is run — the user lassos/boxes what they want by hand.
# ---------------------------------------------------------------------------
_LABEL_PREFS = ["deal_name", "dealname", "deal", "name", "prospect", "label", "title", "deal_id", "id"]


def _pick_label_field(fields: list[str]) -> str | None:
    low = {f.lower(): f for f in fields}
    for p in _LABEL_PREFS:
        if p in low:
            return low[p]
    return fields[0] if fields else None


def _reproject_geom(gj: dict, tf: Transformer) -> dict | None:
    def ring(r):
        return [list(tf.transform(x, y)) for x, y in r]
    if gj.get("type") == "Polygon":
        return {"type": "Polygon", "coordinates": [ring(r) for r in gj["coordinates"]]}
    if gj.get("type") == "MultiPolygon":
        return {"type": "MultiPolygon", "coordinates": [[ring(r) for r in poly] for poly in gj["coordinates"]]}
    return None


def _parse_deals(data: bytes) -> list[dict]:
    """Parse a deals .zip into one entry per polygon (reprojected to 4326)."""
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
        tf = Transformer.from_crs(src_crs, CRS.from_epsg(4326), always_xy=True)
        reader = shapefile.Reader(shp=member(".shp"), dbf=member(".dbf"), shx=member(".shx"))
        field_names = [f[0] for f in reader.fields if f[0] != "DeletionFlag"]
        label_field = _pick_label_field(field_names)

        deals: list[dict] = []
        for i, sr in enumerate(reader.iterShapeRecords()):
            geom = _reproject_geom(sr.shape.__geo_interface__, tf)
            if geom is None:
                continue
            rec = sr.record.as_dict()
            lbl = rec.get(label_field) if label_field else None
            label = str(lbl).strip() if lbl not in (None, "") else f"Deal {i + 1}"
            deals.append({"index": i, "label": label, "geometry": geom})

    if not deals:
        raise HTTPException(400, "Shapefile contains no polygon geometry.")
    return deals


@router.post("/deals")
async def upload_deals(file: UploadFile = File(...)) -> dict:
    """Parse a multi-polygon deals shapefile; the frontend picks one to select."""
    return {"deals": _parse_deals(await file.read())}
