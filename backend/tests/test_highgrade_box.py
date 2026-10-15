"""Highgrade forecast-source toggle (BOX plan step 8) — DB-free.

Pins the rules the BOX source must keep: a not-covered PUD is never a zero (its value
is NULL and BOX range bounds never drop it), metrics are validated per source, per-ft
pad values are lateral-weighted, and the workup's analog band follows the in-house
percentile convention (P10 = HIGH).
"""

import datetime as dt
import re

import numpy as np
import pytest
from fastapi import HTTPException

from app.api import box, highgrade
from app.api.highgrade import EconDeck, HighgradeFilters


def test_novi_values_unchanged():
    assert highgrade.row_value_sql("npv25", "novi", "il") == "il.npv25"
    assert highgrade.row_value_sql("oil_eur", "novi", "w") == "w.oil_eur"
    assert highgrade.value_expr("npv25", "sum", "novi") == "sum(il.npv25)"
    assert highgrade.value_expr("well_count", "sum", "novi") == "count(*)"


def test_box_values_come_from_box_streams():
    assert highgrade.row_value_sql("oil_eur", "box", "il") == "bso.eur"
    assert highgrade.row_value_sql("gas_eur", "box", "il") == "bsg.eur"
    # Steven's $MM -> $, from the named-deck join only
    assert highgrade.row_value_sql("box_pv10", "box", "il") == "(be.pv10_mm * 1e6)"


@pytest.mark.parametrize("source,metric", [("box", "npv25"), ("box", "pv10"), ("novi", "box_pv10")])
def test_metric_validated_per_source(source, metric):
    with pytest.raises(HTTPException) as e:
        highgrade.check_metric(source, metric, None)
    assert e.value.status_code == 422
    with pytest.raises(ValueError):
        highgrade.row_value_sql(metric, source, "il")


def test_box_econ_needs_a_named_deck():
    with pytest.raises(HTTPException):
        highgrade.check_metric("box", "box_pv10", None)
    highgrade.check_metric("box", "box_pv10", EconDeck(deck_id="wti70", assumption_set_id="base"))


def test_per_kft_is_lateral_weighted():
    # pad value = sum(EUR) / sum(kft) over wells carrying both — not an avg of ratios
    e = highgrade.value_expr("oil_eur_per_kft", "avg", "novi")
    assert e.startswith("(sum(il.oil_eur) FILTER") and "/ NULLIF(sum((il.ll_ft / 1000.0)) FILTER" in e
    # BOX recovers the lateral its stored eur_per_kft used, so a 1-well pad == stored value
    eb = highgrade.value_expr("oil_eur_per_kft", "avg", "box")
    assert "sum(bso.eur)" in eb and "(bso.eur / NULLIF(bso.eur_per_kft, 0))" in eb


def test_n_valued_counts_only_wells_with_a_value():
    assert highgrade.n_valued_expr("oil_eur", "box") == "count(bso.eur)"
    assert highgrade.n_valued_expr("well_count", "box") == "count(*)"


def test_box_range_never_drops_a_not_covered_pud():
    f = HighgradeFilters(ranges={"box_oil_eur_per_kft": (60000.0, None), "rqs": (None, 0.5)})
    clauses, params, _ = highgrade._build_filters(f, box=True)
    assert "(bp.coverage IS DISTINCT FROM 'covered' OR bso.eur_per_kft >= :box_oil_eur_per_kft_lo)" in clauses
    assert "(rqs <= :rqs_hi)" in clauses  # Novi attribute bounds keep their NULL-drop semantics
    assert params == {"box_oil_eur_per_kft_lo": 60000.0, "rqs_hi": 0.5}


def test_box_range_ignored_without_box_joins():
    f = HighgradeFilters(ranges={"box_oil_eur": (1.0, 2.0)})
    clauses, params, _ = highgrade._build_filters(f, box=False)
    assert clauses == [] and params == {}


def test_coverage_classes_cover_the_sql_60_values():
    # every box.pud_forecast.coverage value (sql/60 CHECK) must be a class, plus the derived three
    sql60 = {"covered", "not_covered_emerging", "not_covered_wcxy", "not_covered_unvalidated",
             "not_covered_outside_extent", "not_covered_no_analogs"}
    assert sql60 <= set(box.COVERAGE_CLASSES)
    assert set(box.COVERAGE_CLASSES) - sql60 == {"bench_not_in_box", "realized", "no_box_row"}
    derived = set(re.findall(r"THEN '([a-z_]+)'", box.coverage_sql("il")))
    assert derived <= set(box.COVERAGE_CLASSES)


def test_months_between_is_calendar():
    assert box.months_between(dt.date(2024, 11, 1), dt.date(2024, 11, 1)) == 1
    assert box.months_between(dt.date(2024, 11, 1), dt.date(2025, 2, 1)) == 4


def test_actual_cum_per_kft_counts_idle_months_and_stops_at_data_through():
    rows = [{"prod_date": dt.date(2026, 1, 1), "oil": 1000}, {"prod_date": dt.date(2026, 3, 1), "oil": 500}]
    c = box.actual_cum_per_kft(rows, dt.date(2026, 1, 1), 10_000.0, dt.date(2026, 4, 1), k=6)
    assert list(c[:4]) == [100.0, 100.0, 150.0, 150.0]  # Feb idle = 0, Apr seen with no report = 0
    assert np.isnan(c[4:]).all()  # after data_through: not yet observed


def test_band_is_p10_high():
    curves = [np.array([1.0, 2.0]), np.array([2.0, 4.0]), np.array([3.0, np.nan])]
    b = box.band(curves)
    assert b is not None
    assert b["p10"][0] > b["p50"][0] > b["p90"][0]  # SPE: P10 = HIGH
    assert b["p10"][1] is None and b["n"] == [3, 2]  # fewer than 3 analogs reporting -> blank
    assert box.band(curves[:2]) is None
