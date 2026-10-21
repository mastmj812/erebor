"""Highgrade on BOX (overhaul step 5) — the pad screen, its filters and the per-DSU
gunbarrel SQL, DB-free.

Pins: Novi supplies only the geometry (no Novi tag, forecast, NPV or tier column is read;
the population is every non-PDP stick minus OUR realized reconciliation, not Novi's PUD
tag), a location without a BOX forecast is never a zero (its value is NULL and a BOX /
econ bound never drops it), per-ft pad values are lateral-weighted, IRR and breakeven
aggregate as a median, and econ needs a priced record run.
"""

import typing

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import box_locations as bl
from app.api import highgrade as hg
from app.api.highgrade import HighgradeFilters

NOVI = ("npv", "il.pv", "deplet_t", "spacing_t", "complet_t", "rqt", "rqs", "intel_pdp_support", "sup.",
        "tvd_excess", "category = 'PUD'", "category IN", "intel_locations", "operator")
KEEP = "bp.coverage IS NULL OR bp.coverage NOT IN ('covered', 'covered_provisional') OR "


def test_metric_literal_matches_the_whitelist():
    assert set(typing.get_args(hg.Metric)) == set(hg.METRICS)
    assert set(hg.ECON_SUMMABLE) == {"pv0", "pv10", "pv15", "pv20", "pv25", "pv30", "capex"}
    assert set(hg.ECON_MEDIAN) == {"irr", "be_wti"}
    with pytest.raises(ValidationError):
        hg.PadsBody(basin="delaware", metric="npv25")  # Novi metrics are gone


def test_values_come_from_box_streams_and_steven():
    assert hg.row_value_sql("oil_eur") == "bso.eur"
    assert hg.row_value_sql("gas_eur") == "bsg.eur"
    assert hg.row_value_sql("water_eur") == "bsw.eur"
    assert hg.row_value_sql("pv10") == "(be.pv10_mm * 1e6)"  # Steven's $MM -> $
    assert hg.row_value_sql("irr") == "be.irr_pct" and hg.row_value_sql("be_wti") == "be.breakeven_wti_pv20"
    with pytest.raises(ValueError):
        hg.row_value_sql("npv25")


def test_per_kft_is_lateral_weighted_on_the_stored_basis():
    e = hg.value_expr("oil_eur_per_kft", "sum")
    assert e == ("(sum(bso.eur) FILTER (WHERE bso.eur IS NOT NULL AND (bso.eur / NULLIF(bso.eur_per_kft, 0)) > 0) / "
                 "NULLIF(sum((bso.eur / NULLIF(bso.eur_per_kft, 0))) FILTER (WHERE bso.eur IS NOT NULL AND "
                 "(bso.eur / NULLIF(bso.eur_per_kft, 0)) > 0), 0))")
    assert hg.resolve_agg("water_eur_per_kft", "per_acre") == "lateral_weighted"


@pytest.mark.parametrize("metric,agg,applied", [
    ("irr", "sum", "median"), ("be_wti", "avg", "median"), ("pv10", "per_acre", "per_acre"),
    ("capex", "avg", "avg"), ("oil_eur", "per_acre", "sum"), ("well_count", "avg", "count"),
])
def test_aggregation_applied(metric, agg, applied):
    assert hg.resolve_agg(metric, agg) == applied


def test_irr_and_breakeven_are_pad_medians():
    assert hg.value_expr("irr", "sum") == "percentile_cont(0.5) WITHIN GROUP (ORDER BY be.irr_pct)"
    assert hg.value_expr("pv10", "avg") == "avg((be.pv10_mm * 1e6))"


def test_n_valued_counts_only_locations_with_a_value_and_splits_by_tier():
    assert hg.n_valued_expr("oil_eur") == "count(bso.eur)"
    assert hg.n_valued_expr("well_count") == "count(*)"
    assert hg.n_valued_expr("pv10", coverage="covered") == "count((be.pv10_mm * 1e6)) FILTER (WHERE bp.coverage = 'covered')"
    assert "AND bp.coverage = 'covered_provisional'" in hg.n_valued_expr("gas_eur_per_kft", coverage="covered_provisional")


def test_econ_metric_needs_a_priced_run():
    with pytest.raises(HTTPException) as e:
        hg.check_metric("pv10", priced=False)
    assert e.value.status_code == 422
    hg.check_metric("pv10", priced=True)
    hg.check_metric("oil_eur", priced=False)


def test_bounds_never_drop_a_location_without_a_forecast():
    f = HighgradeFilters(ranges={"oil_eur_per_kft": (60000.0, None), "econ_pv10": (0.0, None)})
    clauses, params, _ = hg.build_filters(f, econ=True)
    assert f"({KEEP}bso.eur_per_kft >= :oil_eur_per_kft_lo)" in clauses
    assert f"({KEEP}be.pv10_mm >= :econ_pv10_lo)" in clauses
    assert params == {"oil_eur_per_kft_lo": 60000.0, "econ_pv10_lo": 0.0}


def test_econ_bound_ignored_without_a_priced_run_and_unknown_columns_ignored():
    f = HighgradeFilters(ranges={"econ_irr": (20.0, None), "rqs": (None, 0.5), "npv25": (0.0, None)})
    assert hg.build_filters(f, econ=False) == ([], {}, [])
    assert hg.has_econ_range(f) and not hg.has_econ_range(HighgradeFilters(ranges={"econ_irr": (None, None)}))


def test_bench_and_prox_filters():
    f = HighgradeFilters(formation_blueox=["WCA_1"], prox=["haircut", "no_precedent"])
    clauses, params, expanding = hg.build_filters(f, econ=False)
    assert clauses == ["COALESCE(el.formation_blueox, '(unmapped)') IN :formation_blueox", "bpp.outcome IN :prox"]
    assert params["prox"] == ["haircut", "no_forecast_precedent", "no_forecast_package"]
    assert [b.key for b in expanding] == ["formation_blueox", "prox"]
    with pytest.raises(ValidationError):
        HighgradeFilters(prox=["bogus"])
    assert set(HighgradeFilters.model_fields) == {"formation_blueox", "prox", "ranges"}  # no Novi tier / operator


def test_population_is_every_stick_minus_our_realized():
    assert hg.POPULATION == ("el.basin = :basin AND el.category <> 'PDP' "
                             "AND el.recon_status IS DISTINCT FROM 'realized_drift' "
                             "AND el.recon_status IS DISTINCT FROM 'realized_phantom'")
    assert "realized" not in hg.HG_COVERAGE_CLASSES and bl.NOT_SCREENED in hg.HG_COVERAGE_CLASSES
    assert set(hg.HG_COVERAGE_CLASSES) >= set(bl.FORECAST_CLASSES)


@pytest.mark.parametrize("metric,econ", [("oil_eur_per_kft", False), ("pv10", True), ("irr", True), ("well_count", False)])
def test_pads_sql_reads_box_not_novi(metric, econ):
    sql = hg.pads_sql(metric, "sum", "", econ)
    for novi in NOVI:
        assert novi not in sql, novi
    assert "FROM curated.erebor_locations el" in sql and hg.POPULATION in sql
    assert "LEFT JOIN box.pud_forecast bp ON bp.run_id = :box_run AND bp.stick_id = el.stick_id" in sql
    assert ("box_econ.box_pud_econ be" in sql) == econ
    assert "curated.intel_pad_geom p ON p.basin = :basin" in sql and "'geom_source', geom_source" in sql
    for c in hg.HG_COVERAGE_CLASSES:
        assert f"AS nc_{c}" in sql


def test_per_acre_divides_by_the_dsu_acres_only_for_money():
    assert "a.value / NULLIF(p.acres, 0)" in hg.pads_sql("pv10", "per_acre", "", True)
    assert "a.value / NULLIF(p.acres, 0)" not in hg.pads_sql("oil_eur", "per_acre", "", False)


def test_gunbarrel_sql_box_only_two_arms():
    sql = hg.gunbarrel_sql("oil_eur_per_kft", ["bpp.outcome IN :prox"], econ=False)
    for novi in NOVI:
        assert novi not in sql, novi
    loc, pdp = sql.split("UNION ALL")
    assert "(bpp.outcome IN :prox) AS in_filter" in loc and hg.POPULATION in loc
    assert "intel_pad_member pm ON pm.stick_id = el.stick_id AND pm.pad_key = :pad_key" in loc
    assert "AS coverage" in loc and "AS kind" not in loc and "AS category" in loc
    assert "'PDP' AS category" in pdp and "false AS in_filter" in pdp and "box." not in pdp
    assert "true AS in_filter" in hg.gunbarrel_sql("well_count", [], econ=False)
    # both arms carry the same columns in the same order (UNION ALL)
    def alias(c: str) -> str:
        return c.split(" AS ")[-1] if " AS " in c else c.split(".")[-1]
    loc_cols = hg.gb_columns("x", "true", True)
    assert [alias(c) for c in loc_cols] == [alias(c) for c in hg.gb_columns("x", "false", False)]
    assert {"coverage", "oil_eur_ft", "gas_eur_ft", "water_eur_ft", "prox_outcome", "metric_value"} <= {alias(c) for c in loc_cols}


def test_pads_return_the_color_scale_percentiles_over_valued_drawn_pads():
    sql = " ".join(hg.pads_sql("pv10", "sum", "", True).split())
    for q, k in ((0.05, "p5"), (0.50, "p50"), (0.95, "p95")):
        assert (f"'value_{k}', percentile_cont({q:.2f}) WITHIN GROUP (ORDER BY value) "
                f"FILTER (WHERE {hg._VALUED_PAD})") in sql
    assert hg._VALUED_PAD == "geom IS NOT NULL AND value IS NOT NULL AND n_valued > 0"
    # the true range stays alongside (the legend states it)
    assert "'value_min'" in sql and "'value_max'" in sql
