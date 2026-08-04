"""Deal-upload parsing (/api/select/deals) — pure-function tests against
_parse_deals: zipped shapefile regression + the GeoPackage path (Toucan v2
land-department convention: one layer, Type column DSU/Tract, DSU_Num names).
No DB, no TestClient — the endpoint is a thin wrapper."""

from __future__ import annotations

import io
import sqlite3
import struct
import zipfile
from pathlib import Path
from typing import Any

import pytest
import shapefile  # pyshp
import shapely.wkb
from fastapi import HTTPException
from shapely.geometry import Polygon

from app.api.select import _parse_deals

# ~1 sq mile in degrees near the Delaware Basin AOI
_D = 0.017


def _square(lon: float, lat: float) -> list[list[float]]:
    return [[lon, lat], [lon + _D, lat], [lon + _D, lat + _D], [lon, lat + _D], [lon, lat]]


def _sq(lon: float, lat: float, hole: bool = False) -> Polygon:
    shell = _square(lon, lat)
    holes = None
    if hole:
        m = _D / 4
        holes = [[[lon + m, lat + m], [lon + 2 * m, lat + m],
                  [lon + 2 * m, lat + 2 * m], [lon + m, lat + 2 * m], [lon + m, lat + m]]]
    return Polygon(shell, holes)


def _zip_shapefile(polys: list[list[list[float]]], field: str, values: list[str]) -> bytes:
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    with shapefile.Writer(shp=shp, shx=shx, dbf=dbf) as w:
        w.field(field, "C")
        for poly, val in zip(polys, values):
            w.poly([poly])
            w.record(val)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("deal.shp", shp.getvalue())
        z.writestr("deal.shx", shx.getvalue())
        z.writestr("deal.dbf", dbf.getvalue())
    return out.getvalue()


def _gpkg_blob(geom: Polygon, *, empty: bool = False) -> bytes:
    """GPKG binary geometry: magic 'GP', version 0, flags (little-endian, no
    envelope, optional empty bit), srs_id int32, then plain WKB."""
    flags = 0x01 | (0x10 if empty else 0)
    return b"GP\x00" + bytes([flags]) + struct.pack("<i", 4326) + shapely.wkb.dumps(geom)


def _make_gpkg(tmp_path: Path, rows: list[tuple[dict[str, Any], bytes]],
               layer: str = "Toucan v2") -> bytes:
    path = tmp_path / "fixture.gpkg"
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL,
            srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL,
            organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL,
            description TEXT);
        INSERT INTO gpkg_spatial_ref_sys VALUES
            ('WGS 84', 4326, 'EPSG', 4326, 'unused-by-reader', NULL);
        CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY,
            data_type TEXT NOT NULL, identifier TEXT, description TEXT,
            last_change DATETIME, min_x DOUBLE, min_y DOUBLE, max_x DOUBLE,
            max_y DOUBLE, srs_id INTEGER);
        CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL,
            column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL);
    """)
    cols: list[str] = []
    for attrs, _ in rows:
        for k in attrs:
            if k not in cols:
                cols.append(k)
    q = layer.replace('"', '""')
    conn.execute(f'CREATE TABLE "{q}" (fid INTEGER PRIMARY KEY AUTOINCREMENT,'
                 f' geom BLOB{"".join(f", \"{c}\" TEXT" for c in cols)})')
    conn.execute("INSERT INTO gpkg_contents (table_name, data_type, identifier, srs_id)"
                 " VALUES (?, 'features', ?, 4326)", (layer, layer))
    # declared type is deliberately MULTIPOLYGON while blobs hold POLYGON —
    # the reader must classify per blob, never trust the declaration
    conn.execute("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', 'MULTIPOLYGON', 4326, 0, 0)",
                 (layer,))
    for attrs, blob in rows:
        ph = ", ".join(["?"] * (1 + len(cols)))
        conn.execute(
            f'INSERT INTO "{q}" (geom{"".join(f", \"{c}\"" for c in cols)}) VALUES ({ph})',
            [blob] + [attrs.get(c) for c in cols])
    conn.commit()
    conn.close()
    return path.read_bytes()


def test_zip_regression_label_prefs_still_apply():
    data = _zip_shapefile([_square(-103.8, 31.9)], field="deal_name", values=["BRAVEHEART"])
    deals = _parse_deals(data)
    assert [d["label"] for d in deals] == ["BRAVEHEART"]
    assert deals[0]["geometry"]["type"] == "Polygon"


def test_gpkg_dsu_rows_only_with_dsu_num_labels(tmp_path):
    rows = [
        ({"Type": "Tract", "Section": "33"}, _gpkg_blob(_sq(-103.8, 31.9))),
        ({"Type": "DSU", "DSU_Num": "33"}, _gpkg_blob(_sq(-103.8, 31.9))),
        ({"Type": "DSU", "DSU_Num": "12-15"}, _gpkg_blob(_sq(-103.6, 31.9))),
    ]
    deals = _parse_deals(_make_gpkg(tmp_path, rows))
    # Tract rows are skipped (display-only app); DSU_Num names the polygons
    assert [d["label"] for d in deals] == ["DSU 33", "DSU 12-15"]
    assert [d["index"] for d in deals] == [0, 1]


def test_gpkg_without_attributes_shows_every_polygon(tmp_path):
    rows = [({}, _gpkg_blob(_sq(-103.8, 31.9))), ({}, _gpkg_blob(_sq(-103.7, 31.9)))]
    deals = _parse_deals(_make_gpkg(tmp_path, rows, layer="Toucan"))
    assert [d["label"] for d in deals] == ["Deal 1", "Deal 2"]


def test_gpkg_z_flattened_holes_kept_empty_skipped(tmp_path):
    zpoly = Polygon([(x, y, 100.0) for x, y in _square(-103.8, 31.9)])
    rows = [({}, _gpkg_blob(zpoly)),
            ({}, _gpkg_blob(_sq(-103.7, 31.9, hole=True))),
            ({}, _gpkg_blob(_sq(-103.6, 31.9), empty=True))]
    deals = _parse_deals(_make_gpkg(tmp_path, rows))
    assert len(deals) == 2                                     # empty-flag row skipped
    ring0 = deals[0]["geometry"]["coordinates"][0]
    assert all(len(pt) == 2 for pt in ring0)                   # Z flattened
    assert len(deals[1]["geometry"]["coordinates"]) == 2       # hole preserved


def test_garbage_bytes_400():
    with pytest.raises(HTTPException) as exc:
        _parse_deals(b"neither zip nor sqlite")
    assert exc.value.status_code == 400
    assert ".gpkg" in exc.value.detail
