"""Map tab on BOX (overhaul step 3) — app.box_locations + the tile SQL, DB-free.

Pins: a not-covered stick carries no EUR / econ value (never a zero); PDP rows are
never classed (rule 8: producing context, no forecast); Novi's own PUD / RES tag never
classifies a stick (only the geometry comes from Novi);
econ comes only from the record run's priced case and only through the whitelist;
the default econ case is WTI 70 / HH 3 (overhaul decision 3).
"""

import datetime as dt

import pytest

from app import box_locations as bl
from app.api import box, tiles


def test_shared_fragments_have_one_home():
    # api/box re-exports the moved pieces; Highgrade and the tiles read the same objects
    assert box.box_joins is bl.box_joins and box.econ_join is bl.econ_join
    assert box.COVERAGE_CLASSES is bl.COVERAGE_CLASSES and box.record_run is bl.record_run


def test_box_joins_bench_expression_is_injectable():
    assert "bsm.bench = fb.formation_blueox" in bl.box_joins("il")
    assert "bsm.bench = w.formation_blueox" in bl.box_joins("w", bench="w.formation_blueox")
    assert "bp.stick_id = w.stick_id" in bl.box_joins("w", bench="w.formation_blueox")


def test_map_coverage_classes_use_our_facts_only():
    sql = bl.map_coverage_sql("w")
    # PDP first (NULL), then BOX's own class, then our reconciliation, then bench scope
    assert sql.index("w.category = 'PDP' THEN NULL") < sql.index("bp.coverage IS NOT NULL") \
        < sql.index("THEN 'realized'") < sql.index(f"THEN '{bl.NOT_SCREENED}'") < sql.index("bench_not_in_box")
    # Novi's own PUD / RES tag never classifies a stick (Michael, 2026-10-21)
    assert "'RES'" not in sql and "'PUD'" not in sql
    assert bl.NOT_SCREENED in bl.MAP_COVERAGE_CLASSES and "no_box_row" not in bl.MAP_COVERAGE_CLASSES
    # the pad workup classes a stick the same way (its reconciliation comes from `rec`)
    assert bl.MAP_COVERAGE_CLASSES == bl.COVERAGE_CLASSES
    assert f"THEN '{bl.NOT_SCREENED}'" in bl.coverage_sql("il") and "no_box_row" not in bl.coverage_sql("il")


def test_tile_columns_per_foot_and_no_econ_by_default():
    cols = bl.tile_columns("w", None)
    for s, a in (("oil", "bso"), ("gas", "bsg"), ("water", "bsw")):
        assert f"round(({a}.eur_per_kft / 1000.0)::numeric, 1)::float8 AS {s}_eur_ft" in cols
    assert " AS econ" not in cols and "be." not in cols
    # the haircut factor only where it bites (< 1); as-is PUDs carry no property
    assert "CASE WHEN bso.prox_factor < 1 THEN" in cols


def test_tile_econ_is_whitelisted():
    assert "round(be.pv10_mm::numeric, 2)::float8 AS econ" in bl.tile_columns("w", "pv10")
    assert "be.breakeven_wti_pv20" in bl.tile_columns("w", "be_wti")
    with pytest.raises(KeyError):
        bl.tile_columns("w", "pv10_mm; DROP TABLE x")


def test_tile_ships_pdp_or_location_not_novi_tags():
    sql = tiles._mvt_sql("lines", None)
    assert "CASE WHEN w.category = 'PDP' THEN 'PDP' ELSE 'LOCATION' END AS category" in sql
    select = sql.split("FROM curated.erebor_locations")[0]
    for novi in ("w.deplet_t", "w.rqt", "w.npv", "w.pv", "w.oil_eur", "w.gas_eur", "w.pdp_count", "w.inflation_ratio"):
        assert novi not in select


def test_tile_sql_only_joins_econ_when_asked():
    plain = tiles._mvt_sql("lines", None)
    assert "box_econ" not in plain and "intel_lines" in plain
    priced = tiles._mvt_sql("points", "pv10")
    assert "box_econ.box_pud_econ be" in priced and ":econ_deck" in priced and "intel_points" in priced


def _case(deck, aset, day):
    return {"deck_id": deck, "assumption_set_id": aset, "built_at": dt.datetime(2026, 10, day)}


def test_pick_econ_case_default_deck_and_latest_assumption_set():
    cases = [_case("wti60_hh1", "a", 20), _case("wti70_hh3", "old", 19), _case("wti70_hh3", "new", 20)]
    assert bl.pick_econ_case(cases, None) == cases[2]           # default WTI70/HH3, newest build
    assert bl.pick_econ_case(cases, "wti60_hh1") == cases[0]    # the requested deck
    assert bl.pick_econ_case(cases, "wti99_hh9") == cases[2]    # unknown deck -> default
    assert bl.pick_econ_case([_case("wti80_hh2", "a", 1), _case("wti60_hh4", "a", 1)], None)["deck_id"] == "wti60_hh4"
    assert bl.pick_econ_case([], "wti70_hh3") is None           # unpriced run -> no econ anywhere


def test_econ_metric_units_and_direction():
    assert bl.ECON_METRICS["pv10"]["unit"] == "$MM" and bl.ECON_METRICS["pv10"]["better"] == "high"
    assert bl.ECON_METRICS["be_wti"]["better"] == "low"
    assert bl.DEFAULT_DECK == "wti70_hh3" and bl.DEFAULT_ECON_METRIC == "pv10"
    assert bl.EUR_UNITS == {"oil": "bbl/ft", "gas": "mcf/ft", "water": "bbl/ft"}


def test_workup_and_well_lookup_never_gate_on_novi_pud_tag():
    # the pad workup and the single-well BOX lookup read every Novi stick location
    # (geometry only); only PDP is excluded, as on the Map and in Highgrade
    import inspect

    for fn in (box.pad, box.well_forecast):
        src = inspect.getsource(fn)
        assert "category = 'PUD'" not in src and "category <> 'PDP'" in src
