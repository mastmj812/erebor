"""Lasso selection on BOX (overhaul step 4) — selection rollup, gunbarrel and AOI profile SQL,
DB-free.

Pins: Novi supplies only the geometry (no Novi tag, forecast or econ column is read for a
location), BOX values come through app.box_locations, econ joins only when the record run is
priced, the AOI profile reads the record run's exact monthly volumes for forecast-carrying
locations only, and its per-1,000-ft mean uses the stored per-kft's own lateral basis.
"""

import pytest

from app import box_locations as bl
from app.api import gunbarrel, production, select

NOVI_COLS = ("w.npv", "w.pv", "w.oil_eur", "w.gas_eur", "w.deplet_t", "w.rqt", "w.pdp_count", "w.wti_price",
             "w.inflation_ratio", "intel_forecast", "intel_arps")


@pytest.mark.parametrize("rule", ["intersects", "midpoint"])
def test_selection_reads_box_not_novi(rule):
    sql = select.selection_sql(rule, with_econ=False)
    for novi in NOVI_COLS:
        assert novi not in sql
    assert "CASE WHEN w.category = 'PDP' THEN 'PDP' ELSE 'LOCATION' END AS kind" in sql
    assert "LEFT JOIN box.pud_forecast bp ON bp.run_id = :box_run" in sql
    assert "CROSS JOIN aoi" in sql  # the BOX LEFT JOINs must bind to w, not to a comma-joined aoi
    assert "box_econ" not in sql and "econ_pv10" not in sql


def test_selection_econ_only_when_priced_and_whitelisted():
    sql = select.selection_sql("intersects", with_econ=True)
    assert "box_econ.box_pud_econ be" in sql
    for k, m in bl.ECON_METRICS.items():
        assert f"be.{m['col']} AS econ_{k}" in sql
    assert set(select.ECON_KEYS) == {f"econ_{k}" for k in bl.ECON_METRICS} | {"econ_unpriced_reason"}


def test_selection_lateral_basis_is_the_stored_per_kft_lateral():
    assert "bso.eur / NULLIF(bso.eur_per_kft, 0) AS lat_basis_kft" in bl.selection_columns("w", False)


def test_gunbarrel_no_novi_screens_and_optional_econ():
    plain = gunbarrel.gunbarrel_sql("intersects", None)
    for novi in ("recon_status,", "deplet_t", "pdp_count_3mi", "remaining_only", "Tier-4"):
        assert novi not in plain
    assert "box_econ" not in plain and "AS coverage" in plain and "oil_eur_ft" in plain
    assert "be.pv10_mm AS econ" in gunbarrel.gunbarrel_sql("intersects", "pv10")
    assert "GbBody" in dir(gunbarrel) and "remaining_only" not in gunbarrel.GbBody.model_fields


def test_profile_reads_forecast_locations_and_exact_months():
    sql = production.profile_sql("intersects")
    assert f"bp.coverage IN {bl.FORECAST_IN_SQL}" in sql
    assert "box.pud_forecast_month m ON m.run_id = :box_run" in sql
    assert "SUM(m.volume / s.lat_kft) FILTER (WHERE s.lat_kft > 0)" in sql
    assert "intel_forecast" not in sql and "intel_arps" not in sql
    counts = production.counts_sql("intersects")
    assert "count(*) FILTER (WHERE s.coverage = 'covered_provisional') AS n_provisional" in counts
    assert "SELECT s.formation, m.stream" not in counts
    assert not hasattr(production, "AggBody")  # the Novi aggregate is retired


@pytest.mark.parametrize("v,p,tier", [(5, 0, "validated"), (0, 4, "provisional"), (3, 2, "mixed")])
def test_bench_tier(v, p, tier):
    assert production.bench_tier(v, p) == tier
