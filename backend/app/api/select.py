"""AOI selection: every stick inside a drawn polygon with its BOX record-run values.

Reads curated.erebor_locations — the SAME spine the map tiles render — so the
selection matches what's on screen, with the BOX projection joined through
app.box_locations (the one module that reads BOX attributes). Novi supplies only
the stick geometry (Michael 2026-10-21): `kind` is PDP | LOCATION, never Novi's
PUD / RES tag, and no Novi forecast or econ value is returned. A location without a
BOX forecast carries its coverage class and NULL values — never a zero.

Econ = Steven's box_econ.box_pud_econ for the RECORD run's case (`deck`, default
WTI 70 / HH 3), display only with provenance (D13); NULL everywhere when the record
run is not priced. erebor computes no economics: the panel sums / medians what
Steven pushed.

Selection rule (toggleable — materially changes counts on depth-limited deals):
  * intersects : the lateral LINESTRING intersects the AOI  (ST_Intersects)
  * midpoint   : the lateral's midpoint falls inside the AOI (ST_Contains of
                 ST_LineInterpolatePoint(geom, 0.5))

Deal upload (/select/deals) accepts a zipped shapefile (pyshp + the .prj) or a
GeoPackage (app.gpkg_reader — land-department deliverable with Type=DSU/Tract
rows; the DSUs are shown). Either way each polygon is reprojected to EPSG:4326
and returned for DISPLAY only — selection is always an explicit lasso/box draw
by the user.
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any, Literal

import shapefile  # pyshp
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from pyproj import CRS, Transformer
from shapely.geometry import mapping as shapely_mapping
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.box_locations import (
    ECON_METRICS,
    EUR_STREAMS,
    box_joins,
    econ_case,
    econ_join,
    econ_provenance,
    record_run,
    selection_columns,
)
from app.db import get_session
from app.gpkg_reader import pick_label, read_gpkg, sniff_format, split_roles

router = APIRouter(prefix="/select", tags=["select"])

Rule = Literal["intersects", "midpoint"]
MAX_STICKS = 20000  # deals are <5k acres; guard against a basin-wide AOI

_RULE_PREDICATE = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(w.wellstick_geom, 0.5))",
}

# Per-stick keys returned (the frontend rolls up from these so culls / bench filters are
# instant). Econ keys only when the record run is priced.
STICK_KEYS: tuple[str, ...] = (
    "stick_id", "unique_id", "kind", "formation_blueox", "pad_name", "ll_ft",
    "coverage", "water_tier",
    *(f"{s}_eur" for s in EUR_STREAMS), *(f"{s}_eur_per_kft" for s in EUR_STREAMS),
    "lat_basis_kft", "prox_outcome", "prox_factor",
)
ECON_KEYS: tuple[str, ...] = (*(f"econ_{k}" for k in ECON_METRICS), "econ_unpriced_reason")


def selection_sql(rule: Rule, with_econ: bool) -> str:
    pred = _RULE_PREDICATE[rule]
    return f"""
        WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g)
        SELECT w.stick_id, w.unique_id, w.formation_blueox, w.pad_name, w.ll_ft,
               {selection_columns("w", with_econ)}
        FROM curated.erebor_locations w
        CROSS JOIN aoi
        {box_joins("w", bench="w.formation_blueox")}
        {econ_join() if with_econ else ""}
        WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL AND {pred}
        ORDER BY w.stick_id
    """


def _num(v: Any) -> Any:
    return float(v) if v is not None and not isinstance(v, (str, bool, int)) else v


def select_in_aoi(
    session: Session, aoi_geom: dict, basin: str, rule: Rule, deck: str | None = None
) -> dict[str, Any]:
    run = record_run(session, basin)
    case = econ_case(session, run["run_id"], deck)
    params: dict[str, Any] = {"aoi": json.dumps(aoi_geom), "basin": basin, "box_run": run["run_id"]}
    if case is not None:
        params |= {"econ_deck": case["deck_id"], "econ_aset": case["assumption_set_id"]}
    rows = session.execute(text(selection_sql(rule, case is not None)), params).mappings().all()

    truncated = len(rows) > MAX_STICKS
    use = rows[:MAX_STICKS]
    keys = STICK_KEYS + (ECON_KEYS if case is not None else ())
    sticks = [{k: _num(r[k]) for k in keys} for r in use]
    return {
        "basin": basin,
        "rule": rule,
        "count": len(use),
        "truncated": truncated,
        "box_run": {"run_id": run["run_id"], "data_through": run["data_through"],
                    "report_version": run["report_version"]},
        # overhaul decision 2: econ only for the record run; None = not yet priced
        "econ": econ_provenance(session, run["run_id"], case),
        "sticks": sticks,
    }


class SelectBody(BaseModel):
    aoi: dict  # GeoJSON geometry (Polygon/MultiPolygon), EPSG:4326
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"
    deck: str | None = Field(None, max_length=64)  # Steven's deck id; None = default (WTI 70 / HH 3)


@router.post("")
def select(body: SelectBody, session: Session = Depends(get_session)) -> dict:
    return select_in_aoi(session, body.aoi, body.basin, body.rule, body.deck)


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
    """Deal upload -> one entry per polygon (4326). Dispatches on file magic:
    'PK' = zipped shapefile, SQLite header = GeoPackage."""
    kind = sniff_format(data)
    if kind == "zip":
        return _parse_deals_zip(data)
    if kind == "gpkg":
        return _parse_deals_gpkg(data)
    raise HTTPException(400, "Upload a zipped shapefile (.zip) or a GeoPackage (.gpkg).")


def _parse_deals_gpkg(data: bytes) -> list[dict]:
    """GeoPackage -> display polygons. Rows typed 'DSU' are the mapped units
    (Tract rows are skipped — this app has nowhere to show their attributes);
    files without a Type column show every polygon."""
    try:
        layers = read_gpkg(data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    deals: list[dict] = []
    for layer in layers:
        tf = Transformer.from_crs(layer.crs, CRS.from_epsg(4326), always_xy=True)
        dsus, tracts, generic = split_roles(layer.features)
        chosen = dsus if dsus else generic if generic else tracts
        for f in chosen:
            geom = _reproject_geom(shapely_mapping(f.geometry), tf)
            if geom is None:
                continue
            i = len(deals)
            deals.append({"index": i,
                          "label": pick_label(f.attributes, f"Deal {i + 1}"),
                          "geometry": geom})
    if not deals:
        raise HTTPException(400, "GeoPackage contains no polygon geometry.")
    return deals


def _parse_deals_zip(data: bytes) -> list[dict]:
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
    """Parse a multi-polygon deals shapefile (.zip) or GeoPackage (.gpkg);
    the frontend displays the polygons and offers zoom-to-deal."""
    return {"deals": _parse_deals(await file.read())}
