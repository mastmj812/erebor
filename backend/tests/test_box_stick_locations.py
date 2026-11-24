"""BOX sticks ARE the locations (engineering_db docs/box_sticks_plan.md, phase 6) — DB-free.

Pins: the undrilled rows of curated.erebor_locations are the record BOX stick set, so there is
no separate preview any more (no /api/tiles/box endpoint, no `box_sticks` gunbarrel flag); the
tile carries the landing TVD and the nightly status for the hover; a gunbarrel is one point per
producing LEG (a U-turn stick: two points, one stick_id), read from the basin's record stick set,
on a frame whose mean lateral direction is AXIAL (opposite legs never cancel or flip it); Highgrade
groups sticks by their own DSU (pad_id) and draws raw_novi_intel.pads at the record set's vintage;
the workup endpoints read the stick from curated.erebor_locations, and a BOX stick's Novi
comparison is empty, not an error.
"""

import inspect
import re
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import box_locations as bl
from app.api import box, gunbarrel, production, tiles, workup
from app.api import highgrade as hg
from app.db import get_session
from app.main import app

RECORD_LEGS = ("LEFT JOIN (box.location_stick k JOIN box.location_set t "
               "ON t.set_id = k.set_id AND t.is_record AND t.basin = :basin) ")


# --- the preview is gone ---------------------------------------------------------------------
def test_no_preview_endpoint_flag_or_fragment_remains(monkeypatch):
    monkeypatch.setattr(tiles, "_fetch_tile", lambda *a: pytest.fail("no tile query for a removed endpoint"))
    app.dependency_overrides[get_session] = lambda: None
    try:
        r = TestClient(app).get("/api/tiles/box/11/1/1.mvt?basin=delaware")
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert r.status_code in (404, 422)
    for name in ("box_stick_tile_sql", "box_stick_gunbarrel_sql", "BOX_STICK_LAYER", "BOX_STICK_MIN_Z"):
        assert not hasattr(bl, name), name
    assert not hasattr(tiles, "box_stick_tile") and not hasattr(tiles, "box_stick_tile_key")
    assert not hasattr(gunbarrel, "box_stick_points")
    assert set(gunbarrel.GbBody.model_fields) == {"aoi", "basin", "rule", "econ", "deck"}


# --- tiles -----------------------------------------------------------------------------------
@pytest.mark.parametrize("kind,layer", [("points", "intel_points"), ("lines", "intel_lines")])
def test_tile_carries_landing_tvd_and_nightly_status(kind, layer):
    sql = tiles._mvt_sql(kind, ())
    select = sql.split("FROM curated.erebor_locations")[0]
    assert "round(w.tvd)::int AS tvd" in select and "w.recon_status" in select
    assert "CASE WHEN w.category = 'PDP' THEN 'PDP' ELSE 'LOCATION' END AS category" in select
    assert f"'{layer}'" in sql and "box.location_stick" not in sql      # the spine row IS the stick: one line each
    assert "bp.stick_id = w.stick_id" in sql                            # the forecast join is unchanged
    assert "Novi stick" not in sql


def test_statuses_are_the_nightly_words_without_producing():
    # a producing stick is not a row of curated.erebor_locations; crowded is a status there
    assert bl.BOX_STICK_STATUSES == ("open", "permitted", "pending", "conflict", "crowded")
    assert "not_covered_conflict" in bl.COVERAGE_CLASSES and "not_covered_conflict" in hg.HG_COVERAGE_CLASSES


# --- the leg fragment ------------------------------------------------------------------------
def test_leg_join_reads_the_record_set_and_falls_back_to_the_row_itself():
    j = bl.leg_join("w")
    assert j.startswith(RECORD_LEGS + "ON k.location_id = w.stick_id AND w.category <> 'PDP' ")
    assert j.endswith("CROSS JOIN LATERAL ST_Dump(COALESCE(k.legs_geom, ST_Multi(w.wellstick_geom))) g")
    assert "turn_geom" not in j                                          # the turn arc is not a producing leg
    assert bl.LEG_COLUMNS.startswith("g.path[1] AS leg_no, COALESCE(k.n_legs, 1) AS n_legs, ")
    for col in ("mx", "my", "sx", "sy", "ex", "ey"):
        assert f" AS {col}" in bl.LEG_COLUMNS
    assert "ST_LineInterpolatePoint(g.geom, 0.5)" in bl.LEG_COLUMNS and "wellstick_geom" not in bl.LEG_COLUMNS
    assert "abs(" not in j.lower()                                       # the id sign is never folded


@pytest.mark.parametrize("rule", ["intersects", "midpoint"])
@pytest.mark.parametrize("econ", [None, "pv10"])
def test_gunbarrel_sql_is_one_row_per_leg_of_the_record_set(rule, econ):
    sql = gunbarrel.gunbarrel_sql(rule, econ)
    assert bl.leg_join("w") in sql and bl.LEG_COLUMNS in sql
    assert "FROM curated.erebor_locations w" in sql and "bp.stick_id = w.stick_id" in sql
    assert "ST_Intersects(w.wellstick_geom, aoi.g)" in sql               # the AOI test stays on the indexed column
    assert ("ST_Contains(aoi.g, ST_LineInterpolatePoint(g.geom, 0.5))" in sql) == (rule == "midpoint")
    assert "ST_LineInterpolatePoint(w.wellstick_geom" not in sql         # never the midpoint of a U-turn's one line
    assert "w.tvd" in sql
    assert ("box_econ.box_pud_econ be" in sql) == (econ is not None)
    assert not re.search(r"\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b", sql)


# --- the axial frame -------------------------------------------------------------------------
LON, LAT = -103.70, 32.00
DLON = 0.0030          # about 925 ft of longitude at this latitude
HALF = 0.014           # half a lateral, degrees of latitude (about 1 mi)


def _row(i, lon, tvd, cat="PDP", leg=1, n_legs=1, flip=False, east_west=False, lat=LAT):
    """One leg. N-S by default (heel south -> toe north; `flip` = drilled the other way);
    `east_west` lays it W -> E through (lon, lat)."""
    if east_west:
        s, e = (lon - HALF, lat), (lon + HALF, lat)
    else:
        s, e = (lon, lat - HALF), (lon, lat + HALF)
    if flip:
        s, e = e, s
    box_stick = cat != "PDP"
    return {"stick_id": i, "unique_id": f"10701-BS3_S-{i % 100:02d}" if box_stick else str(-i), "category": cat,
            "formation": "BS3_S" if box_stick else "BONE SPRING", "formation_blueox": "BS3_S", "basin_blueox": "delaware",
            "formation_blueox_source": "box_sticks" if box_stick else "pdp_join",
            "coverage": "covered" if box_stick else None, "oil_eur_ft": 55.5 if box_stick else None,
            "gas_eur_ft": None, "water_eur_ft": None, "prox_outcome": None,
            "tvd": tvd, "ll_ft": 20000.0 if n_legs > 1 else 10000.0, "leg_no": leg, "n_legs": n_legs,
            "in_filter": True, "metric_value": None, "pad_name": "Delaware Pad 701" if box_stick else None,
            "mx": (s[0] + e[0]) / 2, "my": (s[1] + e[1]) / 2, "sx": s[0], "sy": s[1], "ex": e[0], "ey": e[1]}


class _Session:
    def __init__(self, rows):
        self.rows, self.sqls = rows, []

    def execute(self, stmt, params=None):
        self.sqls.append(str(stmt))
        return SimpleNamespace(mappings=lambda: SimpleNamespace(all=lambda: self.rows))


AOI_GB, DSU_GB = "/api/gunbarrel", "/api/highgrade/gunbarrel"


def _post(monkeypatch, rows, url=AOI_GB):
    """The one cross-section of either gunbarrel endpoint for `rows` (the SQL result), plus the session."""
    monkeypatch.setattr(gunbarrel, "record_run_id", lambda s, b: 32)
    monkeypatch.setattr(hg, "record_run", lambda s, b: {"run_id": 32})
    monkeypatch.setattr(hg, "econ_case", lambda s, r, d: None)       # an unpriced record run
    sess = _Session(rows)
    app.dependency_overrides[get_session] = lambda: sess
    try:
        body = {"aoi": {"type": "Polygon", "coordinates": []}} if url == AOI_GB else {"pad_key": "10701"}
        r = TestClient(app).post(url, json={"basin": "delaware", **body})
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert r.status_code == 200, r.text
    out = r.json()
    if url == AOI_GB:
        return (out["pads"][0] if out["pads"] else out), sess
    return out, sess


UTURN = [_row(10050002, LON - 2 * DLON, 11505.0, "LOCATION", leg=1, n_legs=2),
         _row(10050002, LON - 3 * DLON, 11505.0, "LOCATION", leg=2, n_legs=2, flip=True)]
SINGLE = _row(10050001, LON + 2 * DLON, 11510.0, "LOCATION")
PDP = [_row(-3001512345, LON - DLON, 11500.0), _row(-3001512346, LON + DLON, 11520.0, flip=True)]


def test_axial_sum_turns_every_vector_to_the_first():
    assert gunbarrel.axial_sum([(0.0, 1.0), (0.0, -1.0)]) == (0.0, 2.0)          # a U-turn: no cancelling
    assert gunbarrel.axial_sum([(0.0, -1.0), (0.0, 1.0), (0.5, 1.0)]) == (-0.5, -3.0)
    assert gunbarrel.axial_sum([(1.0, 0.0), (0.0, 1.0)]) == (1.0, 1.0)           # perpendicular (dot 0) is kept as is
    assert gunbarrel.axial_sum([]) == (0.0, 0.0)


def test_gunbarrel_is_one_point_per_leg_with_the_sticks_tvd(monkeypatch):
    pad, sess = _post(monkeypatch, [*UTURN, SINGLE, *PDP])
    assert len(sess.sqls) == 1 and "box.location_stick k" in sess.sqls[0]        # one query: no separate BOX read
    assert set(pad) == {"pad_name", "well_count", "stick_count", "axis_left", "axis_right", "wells"}
    assert pad["well_count"] == 5 and pad["stick_count"] == 4                    # points vs sticks / wells
    assert (pad["axis_left"], pad["axis_right"]) == ("W", "E")
    assert [w["stick_id"] for w in pad["wells"]] == [10050002, 10050002, -3001512345, -3001512346, 10050001]   # W -> E
    legs = [w for w in pad["wells"] if w["stick_id"] == 10050002]
    assert [(w["leg_no"], w["n_legs"]) for w in legs] == [(2, 2), (1, 2)]        # leg 2 lies west of leg 1
    assert legs[0]["tvd"] == legs[1]["tvd"] == 11505.0
    assert legs[1]["offset_ft"] - legs[0]["offset_ft"] == pytest.approx(DLON * 111320.0 * 0.848048 * 3.28084, rel=2e-3)
    assert all(w["category"] == "LOCATION" and w["coverage"] == "covered" and w["oil_eur_ft"] == 55.5 for w in legs)
    assert all((w["leg_no"], w["n_legs"]) == (1, 1) for w in pad["wells"] if w["stick_id"] != 10050002)
    assert len({(w["stick_id"], w["leg_no"]) for w in pad["wells"]}) == 5        # the client's marker key
    assert _post(monkeypatch, [])[0] == {"pad_count": 0, "pads": []}


@pytest.mark.parametrize("url", [AOI_GB, DSU_GB])
def test_a_u_turn_stick_alone_neither_cancels_nor_flips_the_axis(monkeypatch, url):
    # summed as directed vectors the two legs cancel (norm 0 -> the fallback axis); here they must not
    for rows in (UTURN, UTURN[::-1]):
        pad, _ = _post(monkeypatch, rows, url)
        assert (pad["axis_left"], pad["axis_right"]) == ("W", "E")
        assert [w["leg_no"] for w in pad["wells"]] == [2, 1] and pad["stick_count"] == 1 and pad["well_count"] == 2
        assert pad["wells"][1]["offset_ft"] == pytest.approx(-pad["wells"][0]["offset_ft"], abs=0.2)
    # an E-W U-turn: cancelled legs would fall back to the E-W axis (W -> E); the section must read S -> N
    ew = [_row(10050003, LON, 11505.0, "LOCATION", leg=1, n_legs=2, east_west=True),
          _row(10050003, LON, 11505.0, "LOCATION", leg=2, n_legs=2, east_west=True, flip=True, lat=LAT + 0.003)]
    pad, _ = _post(monkeypatch, ew, url)
    assert (pad["axis_left"], pad["axis_right"]) == ("S", "N") and [w["leg_no"] for w in pad["wells"]] == [1, 2]


@pytest.mark.parametrize("url", [AOI_GB, DSU_GB])
def test_mixed_direction_producers_give_the_axis_of_the_same_wells_one_way(monkeypatch, url):
    lons = [LON + i * DLON for i in range(-2, 3)]
    one_way = [_row(-3001500000 - i, lon, 11500.0 + i) for i, lon in enumerate(lons)]
    mixed = [_row(-3001500000 - i, lon, 11500.0 + i, flip=i in (0, 1, 3)) for i, lon in enumerate(lons)]   # 3 of 5 reversed
    a, _ = _post(monkeypatch, one_way, url)
    b, _ = _post(monkeypatch, mixed, url)
    assert (a["axis_left"], a["axis_right"]) == (b["axis_left"], b["axis_right"]) == ("W", "E")
    assert [(w["stick_id"], w["offset_ft"]) for w in a["wells"]] == [(w["stick_id"], w["offset_ft"]) for w in b["wells"]]
    assert a["wells"][0]["offset_ft"] < 0 < a["wells"][-1]["offset_ft"]


# --- Highgrade: the stick's own DSU ------------------------------------------------------------
def test_dsu_polygons_are_the_record_sets_vintage():
    sql = bl.dsu_polygons_sql()
    assert "FROM raw_novi_intel.pads q" in sql
    assert "JOIN box.location_set t ON t.is_record AND t.basin = :basin AND t.dsu_vintage = q.report_version" in sql
    assert "WHERE q.basin = :basin" in sql
    assert "ST_Area(q.geom::geography) / 4046.8564224 AS acres" in sql
    assert "q.pad_id" in sql and "q.pad_name" in sql and "q.geom" in sql


@pytest.mark.parametrize("metric,econ", [("oil_eur_per_kft", False), ("pv10", True), ("well_count", False)])
def test_highgrade_pads_group_by_the_sticks_dsu(metric, econ):
    sql = hg.pads_sql(metric, "per_acre", "", econ)
    assert "SELECT el.pad_id::text AS pad_key" in sql and "GROUP BY el.pad_id" in sql
    assert f"dsu AS ({bl.dsu_polygons_sql()})" in sql and "LEFT JOIN dsu p ON p.pad_id::text = a.pad_key" in sql
    assert "intel_pad_member" not in sql and "intel_pad_geom" not in sql
    # the response shape is kept: one Novi polygon per DSU
    assert "1 AS n_parts" in sql and "'novi_polygon'::text AS geom_source" in sql
    for key in ("'pad_key', pad_key", "'pad_name', pad_name", "'n_parts', n_parts", "'geom_source', geom_source",
                "'names_split'", "'pads_hull'", "'wells_without_pad'", "'acres', round(acres::numeric, 1)"):
        assert key in sql, key


def test_highgrade_gunbarrel_takes_the_dsus_sticks_by_pad_id_one_row_per_leg():
    sql = hg.gunbarrel_sql("oil_eur_per_kft", [], econ=False)
    loc, pdp = sql.split("UNION ALL")
    assert "intel_pad_member" not in sql and "intel_pad_geom" not in sql
    assert f"SELECT d.geom FROM ({bl.dsu_polygons_sql()}) d WHERE d.pad_id::text = :pad_key" in loc
    assert "el.pad_id::text = :pad_key" in loc and hg.POPULATION in loc
    assert bl.leg_join("el") in loc and bl.LEG_COLUMNS in loc
    # producing wells have no pad_id: still the lateral midpoint inside the DSU polygon, one leg each
    assert "ST_Contains(pad.geom, ST_LineInterpolatePoint(el.wellstick_geom, 0.5))" in pdp
    assert "1 AS leg_no, 1 AS n_legs" in pdp and "box.location_stick" not in pdp and "pad_id" not in pdp


def test_highgrade_gunbarrel_points_carry_their_leg(monkeypatch):
    out, _ = _post(monkeypatch, [*UTURN, SINGLE, *PDP], DSU_GB)
    assert out["well_count"] == 5 and out["stick_count"] == 4
    assert out["pad_key"] == "10701" and out["pad_name"] == "Delaware Pad 701"      # the DSU's name, from its sticks
    assert _post(monkeypatch, PDP, DSU_GB)[0]["pad_name"] == "10701"                # producers only: the key
    assert [(w["stick_id"], w["leg_no"], w["n_legs"]) for w in out["wells"]][:2] == [(10050002, 2, 2), (10050002, 1, 2)]
    empty, _ = _post(monkeypatch, [], DSU_GB)
    assert empty == {"pad_name": "10701", "well_count": 0, "stick_count": 0, "wells": []}


# --- workup ------------------------------------------------------------------------------------
def test_workup_lookups_read_the_stick_from_the_spine():
    assert "FROM curated.erebor_locations w" in workup._LOC_SQL and "w.stick_id = :sid" in workup._LOC_SQL
    assert "w.pad_id" in workup._LOC_SQL and "w.recon_status" in workup._LOC_SQL
    assert "bp.stick_id = w.stick_id" in workup._LOC_SQL
    for fn in (box.pad, box.well_forecast):
        src = inspect.getsource(fn)
        assert "FROM curated.erebor_locations el" in src and "map_coverage_sql('el')" in src
        for novi in ("intel_locations", "intel_pad_member", "intel_formation_blueox", "reconciled_inventory"):
            assert novi not in src, novi
    assert "el.pad_id::text = :pad_key" in inspect.getsource(box.pad)
    assert "el.unique_id = :name" in inspect.getsource(box.well_forecast)


def test_an_unknown_stick_id_is_a_404_that_names_box_sticks(monkeypatch):
    monkeypatch.setattr(workup, "record_run", lambda s, b: {"run_id": 32})
    sess = SimpleNamespace(execute=lambda *a, **k: SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: None)))
    app.dependency_overrides[get_session] = lambda: sess
    try:
        r = TestClient(app).get("/api/box/location?basin=delaware&stick_id=10050001")
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert r.status_code == 404 and r.json()["detail"] == "no BOX stick location with that id in this basin"


def test_a_box_stick_has_an_empty_novi_comparison_not_an_error(monkeypatch):
    box_fc = {"run_id": 32, "coverage": "covered", "stick_id": 10050001, "streams": {}}
    monkeypatch.setattr(production, "well_forecast", lambda s, basin, name: box_fc)
    app.dependency_overrides[get_session] = lambda: _Session([])     # no intel_forecast / intel_arps row for the name
    try:
        r = TestClient(app).get("/api/production/well?basin=delaware&name=10701-WCC-03")
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert r.status_code == 200
    out = r.json()
    assert out["has_forecast"] is False and out["forecast"] == {"ip_day": [], "oil": [], "gas": [], "water": []}
    assert out["forecast_end_day"] == 0 and set(out["arps_tail"]["oil"]) == {0.0}    # no Novi curve at all
    assert out["box"] == box_fc
