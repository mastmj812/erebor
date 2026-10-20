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
    assert ("(bp.coverage IS NULL OR bp.coverage NOT IN ('covered', 'covered_provisional') OR "
            "bso.eur_per_kft >= :box_oil_eur_per_kft_lo)") in clauses
    assert "(rqs <= :rqs_hi)" in clauses  # Novi attribute bounds keep their NULL-drop semantics
    assert params == {"box_oil_eur_per_kft_lo": 60000.0, "rqs_hi": 0.5}


def test_box_range_ignored_without_box_joins():
    f = HighgradeFilters(ranges={"box_oil_eur": (1.0, 2.0)})
    clauses, params, _ = highgrade._build_filters(f, box=False)
    assert clauses == [] and params == {}


def test_coverage_classes_cover_the_sql_60_values():
    # every box.pud_forecast.coverage value (sql/60 CHECK + sql/63's D105 tier + sql/65) must be a class, plus the derived three
    sql60 = {"covered", "covered_provisional", "not_covered_emerging", "not_covered_wcxy", "not_covered_unvalidated",
             "not_covered_outside_extent", "not_covered_no_analogs", "not_covered_no_precedent"}  # + sql/65 (D114)
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


def test_monthly_series_cum_ties_to_volumes_and_fills_gaps():
    s = box.monthly_series([1, 3], [304.375, 608.75])  # month 2 absent -> zero
    assert s["cum"] == [304.375, 304.375, 913.125]  # Σ months = the stored EUR basis (D39)
    assert s["rate"][0] == pytest.approx(10.0) and s["rate"][1] == 0.0  # volume / days in month
    assert s["rate_day"][0] == pytest.approx(365.25 / 24) and s["cum_day"][2] == pytest.approx(365.25 / 4)


def _run(haircut):
    hb = {s: {k: {"box_v2_pooled_bias": -0.05, "box_v2_pooled_packages": 100, "box_v2_wf_holdout_bias": 0.01,
                  "box_v2_wf_holdout_packages": 50} for k in box.HORIZONS} for s in box.STREAMS}
    return {"disclosure": {"hindcast_bias": hb}, "haircut": haircut}


def test_disclosure_carries_d92_realised_next_to_the_d62_target():
    h = {"method": "D92 C1", **{s: {k: {"factor": 0.9, "realised_median": 0.91, "realised_p10_p90": [0.93, 0.89]}
                                     for k in box.HORIZONS} | {"tail_factor_median": 0.77, "eur_factor_median": 0.84}
                                  for s in box.STREAMS}}
    rows = box.disclosure_rows(_run(h))
    assert rows[0]["haircut"] == 0.9 and rows[0]["realised_median"] == 0.91
    assert (rows[0]["realised_p10"], rows[0]["realised_p90"]) == (0.93, 0.89)  # P10 = HIGH
    assert box.haircut_method(_run(h))["tail"] == {"oil": 0.77, "gas": 0.77}


def test_disclosure_pre_d92_run_has_no_realised():
    h = {s: {k: {"factor": 0.9} for k in box.HORIZONS} for s in box.STREAMS}
    assert box.disclosure_rows(_run(h))[0]["realised_median"] is None
    assert box.haircut_method(_run(h))["method"] is None


def _run9c():
    """A step-9c run (D103): top level = WCA, every group under by_bench."""
    wca_h = {"method": "D92 C1", **{s: {k: {"factor": 0.94, "realised_median": 0.95, "realised_p10_p90": [0.96, 0.94]}
                                         for k in box.HORIZONS} | {"tail_factor_median": 0.77, "eur_factor_median": 0.84}
                                      for s in box.STREAMS}}
    bs_h = {"method": "D92 C1", **{s: {k: {"factor": 0.891, "realised_median": 0.895, "realised_p10_p90": [0.9, 0.89]}
                                        for k in box.HORIZONS} | {"tail_factor_median": 0.68, "eur_factor_median": 0.77}
                                     for s in box.STREAMS}}
    wx_h = {"method": "none (D97: WCXY record = raw box_v2)", **{s: {k: {"factor": 1.0, "realised_median": 1.0, "realised_p10_p90": [1.0, 1.0]}
                                                                       for k in box.HORIZONS} | {"tail_factor_median": 1.0, "eur_factor_median": 1.0}
                                                                    for s in box.STREAMS}}
    wca_d = _run(wca_h)["disclosure"] | {"radius_ranges": {"5 mi ring|cum-12": {"p90_low": -0.34, "p10_high": 0.35, "packages": 190, "bias": 0.0}}}

    def d9c(disc_b):
        hb = {s: {k: {"record_variant": "box_v2_wf", "box_v2_pooled_bias": -0.109, "box_v2_pooled_packages": 653, "haircut_factor": 0.891,
                      "disclosed_bias": disc_b, "disclosed_packages": 397, "d99_judged": k in ("12", "24"),
                      "holdout_bias": 0.010 if k in ("12", "24") else None, "holdout_packages": 119 if k in ("12", "24") else None,
                      "d99_interval": [-0.108, 0.091] if k in ("12", "24") else None} for k in box.HORIZONS} for s in box.STREAMS}
        return {"hindcast_bias": hb, "radius_ranges": {"past 5 mi|cum-12": {"p90_low": -0.47, "p10_high": 0.53, "packages": 241, "bias": -0.02}},
                "radius_ranges_basis": "tuning packages"}

    cf = {s: {"F": [0.9] * 48} for s in box.STREAMS}
    return {"haircut": {**wca_h, "by_bench": {"WCA": wca_h, "BS2_S": bs_h, "WCXY_WCA1": wx_h}},
            "disclosure": {**wca_d, "by_bench": {"WCA": wca_d, "BS2_S": d9c(-0.016), "WCXY_WCA1": d9c(-0.092)}},
            "calendar_factor": {**cf, "by_bench": {"WCA": cf, "BS2_S": cf, "WCXY_WCA1": cf}}}


def test_by_bench_groups_show_their_own_haircut_and_disclosed_bias():
    run = _run9c()
    assert box.run_groups(run) == ["WCA", "BS2_S", "WCXY_WCA1"]
    assert box.disclosure_rows(run)[0]["haircut"] == 0.94  # top level stays WCA's (back-compat)
    g = {b["group"]: b for b in box.group_blocks(run, {"BS2_S", "WCXY_WCA1"})}
    assert list(g) == ["BS2_S", "WCXY_WCA1"]  # only the pad's groups, in the run's order
    assert g["BS2_S"]["disclosure"][0]["haircut"] == 0.891 and g["BS2_S"]["spec"] == "box_v2_wf"
    assert g["BS2_S"]["disclosure"][0]["disclosed_bias"] == -0.016
    assert g["BS2_S"]["disclosure"][0]["holdout_bias_after"] == 0.010  # the 9b score
    assert g["BS2_S"]["disclosure"][2]["d99_interval"] is None  # cum-36 not judged in 9b
    assert g["WCXY_WCA1"]["spec"] == "box_v2" and g["WCXY_WCA1"]["disclosure"][0]["haircut"] == 1.0
    assert g["WCXY_WCA1"]["radius_basis"] == "tuning packages"


def test_group_of_and_pre_9c_runs_have_one_wca_group():
    assert (box.group_of("WCA_2"), box.group_of("BS2_S"), box.group_of("WCXY"), box.group_of("BS3_S")) == ("WCA", "BS2_S", "WCXY_WCA1", None)
    h = {s: {k: {"factor": 0.9} for k in box.HORIZONS} for s in box.STREAMS}
    run = _run(h) | {"calendar_factor": {s: {"F": [0.9] * 48} for s in box.STREAMS}}
    run["disclosure"]["radius_ranges"] = {}
    blocks = box.group_blocks(run, {"WCA"})
    assert [b["group"] for b in blocks] == ["WCA"] and blocks[0]["disclosure"][0]["haircut"] == 0.9


def test_n_valued_splits_by_tier():
    assert highgrade.n_valued_expr("oil_eur", "box", coverage="covered") == "count(bso.eur) FILTER (WHERE bp.coverage = 'covered')"
    assert highgrade.n_valued_expr("well_count", "box", coverage="covered_provisional") ==         "count(*) FILTER (WHERE bp.coverage = 'covered_provisional')"
    assert "AND bp.coverage = 'covered'" in highgrade.n_valued_expr("oil_eur_per_kft", "box", coverage="covered")
    assert box.TIER_OF == {"covered": "validated", "covered_provisional": "provisional"}
    assert set(box.FORECAST_CLASSES) <= set(box.COVERAGE_CLASSES)


def _step15_disc(tier, holdout, lead_scope, scopes):
    lines = [{"label": "BS3_S", "scope": sc, "stream": s, "horizon": h, "packages": 100, "bias": -0.03,
              "range_95": [-0.07, 0.01], "cutoffs": 6} for sc in scopes for s in box.STREAMS for h in (12, 24, 36)]
    hb = {s: {k: {"record_variant": "box_v2", "box_v2_pooled_bias": -0.06, "box_v2_pooled_packages": 470,
                  "disclosed_bias": -0.032, "disclosed_packages": 630, "haircut_factor": 1.0,
                  "holdout_bias": 0.055 if holdout.startswith("FAIL") else None, "holdout_packages": 160,
                  "d99_judged": holdout.startswith("FAIL"), "d99_interval": [-0.10, 0.10] if holdout.startswith("FAIL") else None}
              for k in box.HORIZONS} for s in box.STREAMS}
    return {"tier": tier, "label": "why", "holdout": holdout, "lead": {"label": "BS3_S", "scope": lead_scope},
            "lines": lines, "latest_vintage_text": "latest vintage: oil 12.4% below forecast", "hindcast_bias": hb,
            "error_convention": "actual / forecast - 1 (negative = forecast HIGH)",
            "radius_ranges": {"past 5 mi|cum-12": {"p90_low": -0.5, "p10_high": 0.4, "packages": 385, "bias": -0.07}}}


def test_step15_groups_are_keyed_by_bench_and_carry_their_tier():
    run = _run9c()
    raw = {"method": "none (D97)", **{s: {k: {"factor": 1.0} for k in box.HORIZONS} for s in box.STREAMS}}
    cf = {s: {"F": [0.9] * 48} for s in box.STREAMS}
    for g, disc in {"BS3_S": _step15_disc("provisional", "FAIL (scored once 2026-10-18, D99)", "tuning + holdout",
                                          ("tuning", "holdout", "tuning + holdout")),
                    "AVA_1": _step15_disc("provisional", "none (D105: never out-of-time validated)", "tuning", ("tuning",)),
                    "WCB_1": {**_step15_disc("validated", "", "", ()), "holdout": None, "lead": None, "lines": None}}.items():
        run["haircut"]["by_bench"][g] = raw
        run["disclosure"]["by_bench"][g] = disc
        run["calendar_factor"]["by_bench"][g] = cf
    groups = box.run_groups(run)
    assert box.group_of("BS3_S", groups) == "BS3_S" and box.group_of("WCXY", groups) == "WCXY_WCA1"
    assert box.group_of("WCA_1", groups) == "WCA" and box.group_of("BS9_X", groups) is None
    g = {b["group"]: b for b in box.group_blocks(run, set(groups))}
    assert g["WCA"]["tier"] == "validated" and g["WCA"]["lines"] == []  # 9c shape, no tier key in the jsonb
    assert g["WCB_1"]["tier"] == "validated" and not g["WCB_1"]["holdout_failed"]
    bs = g["BS3_S"]
    assert bs["tier"] == "provisional" and bs["holdout_failed"] and bs["spec"] == "box_v2"
    assert bs["formations"] == ["BS3_S"] and bs["lead"] == {"label": "BS3_S", "scope": "tuning + holdout"}
    assert {ln["scope"] for ln in bs["lines"]} == {"tuning", "holdout", "tuning + holdout"}
    assert set(bs["lines"][0]) == {"label", "scope", "stream", "horizon", "packages", "bias", "range_95"}
    # the pooled (disclosed) figure and the holdout score travel in the same row
    assert (bs["disclosure"][0]["disclosed_bias"], bs["disclosure"][0]["holdout_bias_after"]) == (-0.032, 0.055)
    ava = g["AVA_1"]
    assert ava["tier"] == "provisional" and not ava["holdout_failed"] and ava["disclosure"][0]["holdout_bias_after"] is None
    assert ava["latest_vintage_text"].startswith("latest vintage")


# ---------------------------------------------------------------------------
# PDP-proximity layer (record run 14, D112-D116, sql/65)
# ---------------------------------------------------------------------------
def test_no_precedent_is_a_searched_class_without_a_forecast():
    assert "not_covered_no_precedent" in box.COVERAGE_CLASSES
    assert "not_covered_no_precedent" not in box.FORECAST_CLASSES  # no forecast, never a zero
    assert "not_covered_no_precedent" in box.SEARCHED_CLASSES  # keeps its search provenance + bench group
    assert set(box.PROX_OUTCOMES) == {"as_is_unexposed", "as_is_single_parent", "haircut",
                                      "no_forecast_precedent", "no_forecast_package"}  # sql/65 CHECK


def test_box_joins_read_the_proximity_record_without_multiplying_rows():
    j = box.box_joins("il")
    assert "LEFT JOIN box.pud_proximity bpp ON bpp.run_id = bp.run_id AND bpp.location_id = bp.location_id" in j


def test_prox_filter_is_an_explicit_box_screen():
    f = HighgradeFilters(prox=["haircut", "no_precedent"])
    clauses, params, expanding = highgrade._build_filters(f, box=True)
    assert clauses == ["bpp.outcome IN :prox"]
    assert params == {"prox": ["haircut", "no_forecast_precedent", "no_forecast_package"]}
    assert [b.key for b in expanding] == ["prox"]
    assert highgrade._build_filters(f, box=False) == ([], {}, [])  # needs the BOX joins
    with pytest.raises(ValueError):
        HighgradeFilters(prox=["bogus"])


def test_prox_factor_bound_keeps_not_covered_puds():
    f = HighgradeFilters(ranges={"box_prox_factor": (None, 0.9)})
    clauses, params, _ = highgrade._build_filters(f, box=True)
    assert clauses == ["(bp.coverage IS NULL OR bp.coverage NOT IN ('covered', 'covered_provisional') OR "
                       "bso.prox_factor <= :box_prox_factor_hi)"]
    assert params == {"box_prox_factor_hi": 0.9}


def _prox_jsonb():
    return {"counts": {"haircut": 9706, "as_is_unexposed": 25789, "as_is_single_parent": 6980,
                       "no_forecast_package": 4561, "no_forecast_precedent": 3927},
            "inputs": {"source_run": 10, "haircut_table": "0a62"},
            "method": "parents = producing horizontals >= 12 mo ...",
            "decisions": "D112-D116", "table_ref": "haircut_table sha256:0a62 prereg:b20603d",
            "validation": {"accepted_as": "option (a), validated_with_exception: ...",
                           "confirmation": "2026 prospective cohort, first cum-12 read ~2027-Q2",
                           "prereg_commit": "b20603d", "verdict_as_written": "FAIL (P1 1.060 ...)"},
            "survivorship": "factors are measured on operator-selected infills: an upper bound ...",
            "oil_eur_mmbbl": {"after": 23300.106, "before": 29559.533}}


def test_proximity_block_carries_the_basis_and_the_survivorship_caveat():
    b = box.proximity_block({"disclosure": {"by_bench": {}, "proximity": _prox_jsonb()}})
    assert b is not None
    assert b["label"] == "validated_with_exception"
    assert b["verdict_as_written"].startswith("FAIL") and b["accepted_as"].startswith("option (a)")
    assert b["survivorship"].startswith("factors are measured on operator-selected infills")
    assert sum(b["counts"].values()) == 50963 and b["counts"]["haircut"] == 9706
    assert b["counts"]["no_forecast_precedent"] + b["counts"]["no_forecast_package"] == 8488  # = not_covered_no_precedent
    assert b["oil_eur_change"] == pytest.approx(-0.2117, abs=1e-4)  # oil EUR -21 % overall
    assert box.proximity_block({"disclosure": {"hindcast_bias": {}}}) is None  # runs before 11


def _parent(api, cls, bench, dv, dh):
    return {"api10": api, "cls": cls, "parent_bench": bench, "dv_ft": dv, "dh_ft": dh}


def test_config_line_reads_like_the_record_plan():
    prox = {"config_class": "topfill", "n_same": 0, "n_topfill": 3, "n_underfill": 0, "n_parents_total": 3,
            "flanked_same": False, "flanked_topfill": True, "flanked_underfill": False}
    ps = [_parent("4201", "topfill", "WCA_1", 340.0, 450.0), _parent("4202", "topfill", "WCA_1", 300.0, 1100.0),
          _parent("4203", "topfill", "WCA_2", 520.0, 600.0)]
    assert box.config_line(prox, ps) == "topfill · 3 parents · flanked · nearest WCA_1 340 ft vt / 450 ft hz"


def test_config_line_mixed_and_unexposed():
    prox = {"config_class": "mixed", "n_same": 1, "n_topfill": 2, "n_underfill": 2, "n_parents_total": 5,
            "flanked_same": False, "flanked_topfill": True, "flanked_underfill": False}
    line = box.config_line(prox, [_parent("1", "topfill", "WCC", 171.0, 1164.7), _parent("2", "same", "WCA", 0.0, 1300.0)])
    assert line == "mixed · 5 parents (1 same / 2 topfill / 2 underfill) · flanked topfill · nearest WCC 171 ft vt / 1,165 ft hz"
    assert box.config_line({"config_class": None, "n_parents_total": 0}, []) == "no depleted parent"
    assert box.nearest_parent([]) is None
