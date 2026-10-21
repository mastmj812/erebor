"""Single-location BOX workup (Map tab "Workup" window) — app.api.workup, DB-free.

Pins: the build chain reproduces the stored EUR as cohort P50 per 1,000 ft x lateral
multiplier x haircut x proximity (identity verified live on all 42,475 run-14 forecast rows,
2026-10-21) and flags Cui & Cross below 7,500 ft; analog actuals are calendar volumes per
1,000 ft of the analog's own lateral, None (never zero) past the data cut-off; the band is
SPE-oriented (P10 = high); the location SQL reads BOX through app.box_locations and never
opens a PDP row (rule 8); the notes state facts from the cohort, never a verdict.
"""

import datetime as dt

from app.api import workup as wk
from fastapi.testclient import TestClient

from app.box_locations import map_coverage_sql
from app.db import get_session
from app.main import app


def test_route_is_registered():
    # through a request, not app.routes: newer Starlette no longer flattens included routers
    # there. A missing stick_id is a 422 from the route (an unknown path would be a 404);
    # the session dependency is stubbed, so nothing touches the database.
    app.dependency_overrides[get_session] = lambda: None
    try:
        client = TestClient(app)
        assert client.get("/api/box/location?basin=delaware").status_code == 422
        assert client.get("/api/box/location?basin=delaware&stick_id=-3001547072").status_code == 422  # PDP id
    finally:
        app.dependency_overrides.pop(get_session, None)


def test_build_chain_reproduces_the_stored_eur():
    # Delaware Pad 634 1BSS 4 (run 14): raw box_v2, no haircut, as-is proximity
    s = {"eur_raw": 312468.904117132, "eur_haircut": 1.0, "prox_factor": 1.0, "lateral_mult": 18.28,
         "eur": 312468.904117132, "eur_per_kft": 17093.4849079394}
    c = wk.build_chain(s, 18280.0)
    assert c["check"] and not c["cui_cross"]
    assert abs(c["cohort_p50_per_kft"] - 17093.48) < 0.01 and abs(c["eur_per_ft"] - 17.09) < 0.01
    # a haircut + proximity location: EUR = raw x haircut x factor
    s2 = {"eur_raw": 407524.09, "eur_haircut": 0.8431, "prox_factor": 1.0, "lateral_mult": 6.0676, "eur": 343583.57}
    c2 = wk.build_chain(s2, 5080.0)
    assert c2["check"] and c2["cui_cross"]        # 6.07 vs linear 5.08: Cui & Cross (D50)
    assert abs(c2["linear_mult"] - 5.08) < 1e-9
    bad = {**s2, "eur": 400000.0}
    assert wk.build_chain(bad, 5080.0)["check"] is False   # a stored EUR the chain does not reproduce is flagged
    assert wk.build_chain({"eur": None, "eur_raw": None, "lateral_mult": 1.0}, 1000.0) is None


def test_actual_monthly_per_kft_is_calendar_and_none_past_the_cutoff():
    first = dt.date(2025, 1, 1)
    rows = [{"prod_date": dt.date(2025, 1, 1), "v": 10000.0},
            {"prod_date": dt.date(2025, 3, 1), "v": 5000.0}]          # February missing = zero (calendar)
    m = wk.actual_monthly_per_kft(rows, first, 10000.0, dt.date(2025, 4, 1), k=6)
    assert m[:4] == [1000.0, 0.0, 500.0, 0.0] and m[4:] == [None, None]
    assert wk.cum_at(m, 3) == 1500.0 and wk.cum_at(m, 5) is None   # an unobserved month is never a zero


def test_band_is_spe_oriented_on_cumulatives():
    curves = [[1.0, 1.0, None], [2.0, 2.0, 2.0], [3.0, 3.0, 3.0]]
    b = wk.band_monthly(curves)
    assert b["p10"][1] > b["p50"][1] > b["p90"][1]                  # P10 = HIGH
    assert b["p50"][1] == 4.0                                       # cumulative of the middle curve
    assert b["p50"][2] is None                                      # < 3 analogs observed at month 3
    assert wk.band_monthly(curves[:2]) is None


def test_cohort_notes_state_facts():
    loc = {"flags": ["under_count: 3 < min_wells 10 (extend radius / strike-biased — reviewer)"],
           "radius_mi": 20.0, "search_mode": "circle", "lateral_ft": 18280.0}
    analogs = [{"dist_ft": 91954.0, "lateral_ft": 12122.0}, {"dist_ft": 94471.0, "lateral_ft": 12222.0},
               {"dist_ft": 93312.0, "lateral_ft": 12116.0}]
    nearby = [{"dist_ft": 6300.0, "lateral_ft": 10942.0}, {"dist_ft": 10200.0, "lateral_ft": 9706.0}]
    neighbours = [{"oil_eur_ft": 80.6}, {"oil_eur_ft": 91.9}, {"oil_eur_ft": 17.1}]
    notes = wk.cohort_notes(loc, analogs, nearby, neighbours, 17.1)
    text = " ".join(notes)
    assert "3 analogs where the run wants at least 10" in text
    assert "17.4–17.9 mi" in text and "12,116–12,222 ft" in text and "1.51×" in text
    assert "2 same-bench producers within 2 mi are NOT in the cohort" in text
    assert "median oil 80.6 bbl/ft" in text
    assert wk.cohort_notes({"flags": []}, [], [], [], None) == []


def test_location_sql_reads_box_through_the_shared_module_and_never_a_pdp_row():
    assert map_coverage_sql("w") in wk._LOC_SQL
    assert "box.pud_forecast bp ON bp.run_id = :box_run" in wk._LOC_SQL
    assert "w.category <> 'PDP'" in wk._LOC_SQL
    # analogs and nearby producers bind every value; the bench never lands in the SQL text
    for sql in (wk._ANALOGS_SQL, wk._NEARBY_PDP_SQL, wk._NEIGHBOURS_SQL):
        assert ":r" in sql or ":sid" in sql
    assert ":bench" in wk._NEARBY_PDP_SQL and ":bench" in wk._NEIGHBOURS_SQL
    # a geometry prefilter (GiST on wellstick_geom) before any geography distance
    assert "ST_DWithin(el.wellstick_geom, me.g, :deg)" in wk._NEARBY_PDP_SQL
