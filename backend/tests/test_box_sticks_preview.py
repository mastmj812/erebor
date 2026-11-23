"""BOX sticks preview (engineering_db docs/box_sticks_plan.md, phase 5e) — tile and gunbarrel, DB-free.

Pins: the preview reads the RECORD BOX stick set only, geometry + landing + nightly status, never
a forecast or an econ table; its tile answers nothing below zoom 10 and cannot share a cache entry
with the existing tiles; the gunbarrel is unchanged without the flag, and with it the BOX sticks
are extra points in the frame the existing rows define (one per leg), never part of that frame.
"""

import re
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects.postgresql import psycopg as pg_psycopg

from app import box_locations as bl
from app.api import gunbarrel, tiles
from app.db import get_session
from app.main import app
from app.tile_cache import TileCache

NOT_READ = ("box.pud_forecast", "box.pud_stream", "box_econ", "curated.erebor_locations", "box.forecast_run", "eur")


def _sqls():
    return [bl.box_stick_tile_sql(), bl.box_stick_gunbarrel_sql("intersects"), bl.box_stick_gunbarrel_sql("midpoint")]


def test_preview_reads_the_record_set_only_and_no_forecast_or_econ():
    for sql in _sqls():
        assert "JOIN box.location_set t ON t.set_id = k.set_id AND t.is_record AND t.basin = :basin" in sql
        assert "LEFT JOIN curated.box_location_status s ON s.location_id = k.location_id AND s.set_id = k.set_id" in sql
        assert "k.location_id AS stick_id" in sql and "k.target_tvd_ft" in sql and "s.status" in sql
        for t in NOT_READ:
            assert t not in sql, t
        assert not re.search(r"\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b", sql)


def test_tile_sql_keeps_the_index_in_play_and_binds_only_the_tile_and_basin():
    sql = bl.box_stick_tile_sql()
    assert "ST_Intersects(k.legs_geom, ST_Transform((SELECT env FROM bounds), 4326))" in sql
    assert f"'{bl.BOX_STICK_LAYER}'" in sql and bl.BOX_STICK_LAYER == "box_sticks"
    # a U-turn stick is drawn with its turn arc; the index filter stays on the legs
    assert "CASE WHEN k.turn_geom IS NULL THEN k.legs_geom ELSE ST_CollectionExtract(ST_Collect(k.legs_geom, k.turn_geom), 2) END" in sql
    assert "turn_geom" not in bl.box_stick_gunbarrel_sql("intersects")   # the gunbarrel is the producing legs only
    session = SimpleNamespace(get_bind=lambda: SimpleNamespace(dialect=pg_psycopg.dialect()))
    stmt, args = tiles._driver_sql(session, sql, {"z": 11, "x": 434, "y": 831, "basin": "delaware"})
    assert set(args) == {"z", "x", "y", "basin"} and not re.search(r"(?<!:):[a-z_]+\b", stmt)


@pytest.mark.parametrize("rule", ["intersects", "midpoint"])
def test_gunbarrel_sql_is_one_row_per_leg(rule):
    sql = bl.box_stick_gunbarrel_sql(rule)
    assert "CROSS JOIN LATERAL ST_Dump(k.legs_geom) g" in sql and "g.path[1] AS leg_no" in sql
    assert "ST_LineInterpolatePoint(g.geom, 0.5)" in sql                 # a leg is a LineString; legs_geom is not
    assert "ST_Intersects(k.legs_geom, aoi.g)" in sql                    # the GiST index on legs_geom
    assert ("ST_Contains(aoi.g, ST_LineInterpolatePoint(g.geom, 0.5))" in sql) == (rule == "midpoint")
    assert set(gunbarrel._PRED) == set(bl._BOX_STICK_PRED)               # the same selection rules


def test_tile_key_cannot_collide_with_an_existing_tile_key():
    box = tiles.box_stick_tile_key("delaware", 11, 434, 831, 24)
    assert box[0] == "box_sticks" and box != tiles.box_stick_tile_key("delaware", 11, 434, 831, 25)   # record flip misses
    assert all(tiles._tile_key(b, 11, 434, 831, r, (), None)[0] in ("delaware", "midland") for b in ("delaware", "midland") for r in (24, None))


def test_tile_endpoint_is_empty_below_zoom_10_and_keeps_to_its_own_cache_entries(monkeypatch):
    raw, novi = b"\x1a\x0cbox-sticks" * 40, b"\x1a\x0bnovi-lines" * 40
    calls = []
    monkeypatch.setattr(tiles, "_cache", TileCache(1 << 20, 60))
    monkeypatch.setattr(tiles, "record_run_id", lambda s, b: 32)
    monkeypatch.setattr(tiles, "record_set_id", lambda s, b: calls.append(("set", b)) or 24)
    monkeypatch.setattr(tiles, "_fetch_tile",
                        lambda s, sql, p: calls.append(("fetch", "box.location_stick" in sql, dict(p))) or (raw if "box.location_stick" in sql else novi))
    monkeypatch.setattr(tiles.settings, "tile_prewarm", False)
    app.dependency_overrides[get_session] = lambda: None
    try:
        c = TestClient(app)
        assert bl.BOX_STICK_MIN_Z == 10
        low = c.get("/api/tiles/box/9/108/207.mvt?basin=delaware")
        assert low.status_code == 204 and calls == []                    # no lookup, no query
        r1 = c.get("/api/tiles/box/11/434/831.mvt?basin=delaware")
        assert r1.status_code == 200 and r1.content == raw and r1.headers["x-tile-cache"] == "miss"
        assert calls == [("set", "delaware"), ("fetch", True, {"z": 11, "x": 434, "y": 831, "basin": "delaware"})]
        assert c.get("/api/tiles/box/11/434/831.mvt?basin=delaware").headers["x-tile-cache"] == "hit"
        r2 = c.get("/api/tiles/11/434/831.mvt?basin=delaware")           # the existing tile, same coordinates
        assert r2.content == novi and r2.headers["x-tile-cache"] == "miss"
        assert c.get("/api/tiles/box/11/434/831.mvt?basin=delaware").content == raw
        assert c.get("/api/tiles/box/11/434/831.mvt?basin=permian").status_code == 422
        assert c.get("/api/tiles/box/11/4000/831.mvt?basin=delaware").status_code == 400
    finally:
        app.dependency_overrides.pop(get_session, None)


def test_no_record_set_is_an_empty_tile(monkeypatch):
    monkeypatch.setattr(tiles, "record_set_id", lambda s, b: None)
    monkeypatch.setattr(tiles, "_fetch_tile", lambda *a: pytest.fail("no query without a record set"))
    app.dependency_overrides[get_session] = lambda: None
    try:
        assert TestClient(app).get("/api/tiles/box/11/434/831.mvt?basin=midland").status_code == 204
    finally:
        app.dependency_overrides.pop(get_session, None)


# --- gunbarrel ---------------------------------------------------------------------------
LON, LAT = -103.70, 32.00
DLON = 0.0030          # about 925 ft of longitude at this latitude


def _well(i, lon, tvd, cat="PDP"):
    """A N-S lateral, heel south -> toe north."""
    return {"stick_id": i, "unique_id": str(i), "category": cat, "formation": "BONE SPRING", "formation_blueox": "BS3_S",
            "basin_blueox": "delaware", "formation_blueox_source": "x", "coverage": None, "oil_eur_ft": None,
            "gas_eur_ft": None, "water_eur_ft": None, "prox_outcome": None, "tvd": tvd, "ll_ft": 10000.0,
            "mx": lon, "my": LAT, "sx": lon, "sy": LAT - 0.014, "ex": lon, "ey": LAT + 0.014}


def _leg(i, leg, lon, tvd, n_legs=1, flip=False, status="open"):
    s, e = (LAT - 0.014, LAT + 0.014) if not flip else (LAT + 0.014, LAT - 0.014)
    return {"stick_id": i, "well_name": f"10701-BS3_S-{i}", "formation_blueox": "BS3_S", "pad_id": 10701, "n_legs": n_legs,
            "target_tvd_ft": tvd, "tvd_rung": "direct", "tvd_err_median_ft": 35.0, "spacing_ft": 880.0, "ll_ft": 10000.0,
            "status": status, "crowded": False, "matched_api10": None, "flags": ["pinned"], "leg_no": leg,
            "mx": lon, "my": LAT, "sx": lon, "sy": s, "ex": lon, "ey": e}


class _Session:
    def __init__(self, base, box):
        self.base, self.box, self.sqls = base, box, []

    def execute(self, stmt, params=None):
        sql = str(stmt)
        self.sqls.append(sql)
        rows = self.box if "box.location_stick" in sql else self.base
        return SimpleNamespace(mappings=lambda: SimpleNamespace(all=lambda: rows))


def _post(monkeypatch, base, box, **body):
    monkeypatch.setattr(gunbarrel, "record_run_id", lambda s, b: 32)
    sess = _Session(base, box)
    app.dependency_overrides[get_session] = lambda: sess
    try:
        r = TestClient(app).post("/api/gunbarrel", json={"aoi": {"type": "Polygon", "coordinates": []}, "basin": "delaware", **body})
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert r.status_code == 200
    return r, sess


BASE = [_well(-3001512345, LON - DLON, 11500.0), _well(-3001512346, LON + DLON, 11520.0), _well(1600001, LON, 11480.0, "LOCATION")]
BOX = [_leg(10050001, 1, LON + 2 * DLON, 11510.0), _leg(10050002, 1, LON - 2 * DLON, 11505.0, n_legs=2),
       _leg(10050002, 2, LON - 3 * DLON, 11505.0, n_legs=2, flip=True, status="producing")]


def test_without_the_flag_no_box_query_runs_and_no_box_key_is_returned(monkeypatch):
    r, sess = _post(monkeypatch, BASE, BOX)
    assert len(sess.sqls) == 1 and "box.location_stick" not in sess.sqls[0]
    pad = r.json()["pads"][0]
    assert set(pad) == {"pad_name", "well_count", "axis_left", "axis_right", "wells"}
    assert gunbarrel.GbBody.model_fields["box_sticks"].default is False


def test_with_the_flag_the_existing_frame_and_rows_do_not_move(monkeypatch):
    off, _ = _post(monkeypatch, BASE, BOX)
    on, sess = _post(monkeypatch, BASE, BOX, box_sticks=True)
    a, b = off.json()["pads"][0], on.json()["pads"][0]
    assert {k: b[k] for k in a} == a                                     # wells, count and axis: identical
    assert len(sess.sqls) == 2 and b["frame_from"] == "selection" and (b["axis_left"], b["axis_right"]) == ("W", "E")
    pts = b["box_sticks"]
    assert len(pts) == 3 and b["box_stick_count"] == 2                   # one point per leg; the U-turn stick has two
    assert [p["stick_id"] for p in pts] == [10050002, 10050002, 10050001]   # W -> E
    east = next(p for p in pts if p["stick_id"] == 10050001)
    assert east["offset_ft"] == pytest.approx(2 * DLON * 111320.0 * 0.848048 * 3.28084, rel=2e-3) and east["tvd"] == 11510.0
    assert east["category"] == "BOX" and east["status"] == "open" and east["flags"] == ["pinned"] and east["tvd_rung"] == "direct"
    assert not {"coverage", "oil_eur_ft", "econ", "prox_outcome"} & set(east)   # no forecast field on a BOX stick
    assert {p["leg_no"] for p in pts if p["stick_id"] == 10050002} == {1, 2}


def test_a_selection_with_box_sticks_only_gets_its_frame_from_them_axially(monkeypatch):
    r, _ = _post(monkeypatch, [], BOX, box_sticks=True)
    pad = r.json()["pads"][0]
    assert pad["wells"] == [] and pad["well_count"] == 0 and pad["frame_from"] == "box_sticks"
    assert (pad["axis_left"], pad["axis_right"]) == ("W", "E")           # the U-turn's opposite legs did not cancel or flip it
    assert [p["stick_id"] for p in pad["box_sticks"]] == [10050002, 10050002, 10050001]
    empty, _ = _post(monkeypatch, [], [], box_sticks=True)
    assert empty.json() == {"pad_count": 0, "pads": []}
