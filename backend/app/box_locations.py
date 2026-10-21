"""BOX per-location projection — the ONE place erebor reads BOX attributes of a location.

Overhaul plan (docs/overhaul_plan.md): every BOX attribute is read by `location_id`
through this module (box.pud_forecast joins to its stream / proximity / econ rows on
(run_id, location_id)). Today a BOX location IS a Novi stick, so the entry point is
`box.pud_forecast.stick_id` (UNIQUE per run); when BOX-derived locations replace the
Novi sticks (DSU infill), this module and the tile geometry source change, not every
panel.

Shared by the Map tiles (api/tiles.py), Highgrade (api/highgrade.py) and the BOX
workup (api/box.py) so all three class every PUD the same way:

  * the record run (`box.forecast_run.is_record`, at most one — sql/60);
  * coverage classes: box.pud_forecast's own values + derived ones for a Novi stick
    with no row in the record run. NOT covered is a stated class, never a zero (D2/D67);
  * the econ case: Steven's box_econ.box_pud_econ for the RECORD run only — display-only
    with provenance (D13); erebor computes no economics and never shows another run's
    dollars on the record run's volumes (overhaul decision 2).
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

# Every screened PUD lands in exactly one class. The first eight are box.pud_forecast's
# own coverage values (sql/60 + sql/63 + sql/65, D67 / D105 / D114); the last three are
# derived for a PUD with no row in the record run:
#   covered              VALIDATED tier: the bench passed its out-of-time test
#   covered_provisional  PROVISIONAL tier (D105): forecast-carrying exactly like covered,
#                        but the bench was never out-of-time tested (AVA_0/1/2, BS2_C) or
#                        failed its one-time holdout (BS3_S, BS3_C, WCB_2, BS1_S). Counted
#                        apart from covered everywhere, never silently summed into it
#   not_covered_no_precedent  (D114, sql/65) a searched, in-extent PUD whose PDP-proximity
#                        configuration has no drilled precedent: no forecast, search
#                        provenance kept (like not_covered_no_analogs)
#   bench_not_in_box  its bench is in no box.bench_scope pool (not part of BOX v1)
#   not_screened      on a BOX bench, not reconciled away, yet no row in the record run:
#                     Novi-RES sticks inside a BOX pool (D117 step 3 parked), and any
#                     stick that drifted out of the run's Novi vintage
#   realized          our reconciliation matched it to production (Map + pad workup;
#                     Highgrade never screens it)
NOT_SCREENED = "not_screened"
COVERAGE_CLASSES: tuple[str, ...] = (
    "covered",
    "covered_provisional",
    "not_covered_no_analogs",
    "not_covered_no_precedent",
    "not_covered_outside_extent",
    "not_covered_wcxy",
    "not_covered_unvalidated",
    "not_covered_emerging",
    NOT_SCREENED,
    "bench_not_in_box",
    "realized",
)
# Novi supplies only the stick GEOMETRY (Michael, 2026-10-21: Novi's own tags — PUD / RES,
# depletion tiers — are not used anywhere; classification is ours). So a Novi stick with no
# row in the record run is classed by OUR facts only: realized (our reconciliation), on a
# BOX bench but never screened by the record run, or on a bench BOX does not cover. The Map
# and the workup use the same classes (MAP_COVERAGE_CLASSES is kept as the tiles' name).
MAP_COVERAGE_CLASSES: tuple[str, ...] = COVERAGE_CLASSES

# The coverage classes that carry a BOX forecast (volumes, EUR, analogs, charts).
FORECAST_CLASSES: tuple[str, ...] = ("covered", "covered_provisional")
TIER_OF: dict[str, str] = {"covered": "validated", "covered_provisional": "provisional"}
FORECAST_IN_SQL = "('covered', 'covered_provisional')"
# Searched PUDs without a forecast: they keep the analog search provenance and their
# bench's disclosure group (the "screen identity" of a PUD BOX looked at and declined).
SEARCHED_CLASSES: tuple[str, ...] = (*FORECAST_CLASSES, "not_covered_no_analogs", "not_covered_no_precedent")

# PDP-proximity outcomes (box.pud_proximity.outcome, sql/65) grouped into the three
# filter values. A PUD with no box.pud_proximity row (outside the extent, emerging, ...
# — never measured) matches none of them.
PROX_GROUPS: dict[str, tuple[str, ...]] = {
    "as_is": ("as_is_unexposed", "as_is_single_parent"),
    "haircut": ("haircut",),
    "no_precedent": ("no_forecast_precedent", "no_forecast_package"),
}
PROX_OUTCOMES: tuple[str, ...] = tuple(o for g in PROX_GROUPS.values() for o in g)

# Map color / range metrics. EUR per FOOT = stored eur_per_kft / 1000 (bbl/ft oil + water,
# mcf/ft gas), the raw 50-yr technical integral incl. the D62/D102 haircut and the D113
# proximity factor (stored EUR already carries both; nothing here re-applies them).
EUR_STREAMS: tuple[str, ...] = ("oil", "gas", "water")
EUR_UNITS: dict[str, str] = {"oil": "bbl/ft", "gas": "mcf/ft", "water": "bbl/ft"}

# Steven's econ columns erebor may DISPLAY (whitelist -> box_econ.box_pud_econ column,
# unit, and which end is "better" for the color ramp). Display only (D13).
ECON_METRICS: dict[str, dict[str, str]] = {
    "pv0": {"col": "pv0_mm", "unit": "$MM", "better": "high", "label": "PV0"},
    "pv10": {"col": "pv10_mm", "unit": "$MM", "better": "high", "label": "PV10"},
    "pv15": {"col": "pv15_mm", "unit": "$MM", "better": "high", "label": "PV15"},
    "pv20": {"col": "pv20_mm", "unit": "$MM", "better": "high", "label": "PV20"},
    "pv25": {"col": "pv25_mm", "unit": "$MM", "better": "high", "label": "PV25"},
    "pv30": {"col": "pv30_mm", "unit": "$MM", "better": "high", "label": "PV30"},
    "irr": {"col": "irr_pct", "unit": "%", "better": "high", "label": "IRR"},
    "be_wti": {"col": "breakeven_wti_pv20", "unit": "$/bbl WTI", "better": "low", "label": "Breakeven WTI @ PV20"},
    "capex": {"col": "capex_mm", "unit": "$MM", "better": "low", "label": "Capex"},
}
# Default econ case (overhaul decision 3): WTI $70 / HH $3, PV10.
DEFAULT_DECK = "wti70_hh3"
DEFAULT_ECON_METRIC = "pv10"


def box_joins(a: str, bench: str = "fb.formation_blueox") -> str:
    """BOX record-run joins onto a Novi PUD alias `a` (needs param :box_run).
    box.pud_forecast is UNIQUE on (run_id, stick_id) and the stream rows on
    (run_id, location_id, stream), so no join multiplies rows. `bench` = the
    expression holding the PUD's formation_blueox (the `fb` join by default)."""
    return (
        f"LEFT JOIN box.pud_forecast bp ON bp.run_id = :box_run AND bp.stick_id = {a}.stick_id "
        "LEFT JOIN box.pud_forecast_stream bso ON bso.run_id = bp.run_id "
        "AND bso.location_id = bp.location_id AND bso.stream = 'oil' "
        "LEFT JOIN box.pud_forecast_stream bsg ON bsg.run_id = bp.run_id "
        "AND bsg.location_id = bp.location_id AND bsg.stream = 'gas' "
        # PDP-proximity record (sql/65), PK (run_id, location_id); no row on runs before 11
        "LEFT JOIN box.pud_proximity bpp ON bpp.run_id = bp.run_id AND bpp.location_id = bp.location_id "
        "LEFT JOIN box.pud_forecast_stream bsw ON bsw.run_id = bp.run_id "
        "AND bsw.location_id = bp.location_id AND bsw.stream = 'water' "
        # the PUD's bench is in a BOX pool (bench_scope.member_benches; DISTINCT so a
        # bench listed in two pools could never multiply rows).
        "LEFT JOIN (SELECT DISTINCT basin, unnest(member_benches) AS bench FROM box.bench_scope) bsm "
        f"ON bsm.basin = {a}.basin AND bsm.bench = {bench}"
    )


def econ_join() -> str:
    """Steven's priced case (needs :econ_deck, :econ_aset); PK (run, location, deck,
    assumption set) -> at most one row per location. Display-only (D13)."""
    return (
        "LEFT JOIN box_econ.box_pud_econ be ON be.run_id = bp.run_id AND be.location_id = bp.location_id "
        "AND be.deck_id = :econ_deck AND be.assumption_set_id = :econ_aset"
    )


def coverage_sql(a: str) -> str:  # noqa: ARG001 — alias kept for call-site symmetry
    """Coverage class of a Novi stick row from curated.intel_locations (aliases from
    box_joins: `bp`, `bsm`; plus `rec` reconciliation) — the pad workup's twin of
    map_coverage_sql (same classes; this one reads reconciliation from `rec`)."""
    return (
        "(CASE WHEN bp.coverage IS NOT NULL THEN bp.coverage "
        "WHEN rec.status IN ('realized_drift', 'realized_phantom') THEN 'realized' "
        f"WHEN bsm.bench IS NOT NULL THEN '{NOT_SCREENED}' "
        "ELSE 'bench_not_in_box' END)"
    )


def map_coverage_sql(a: str) -> str:
    """Coverage class of a curated.erebor_locations row (`a`) for the Map tiles: NULL on
    PDP (producing context, never forecast — rule 8); otherwise BOX's own class, else
    realized (our reconciliation, sql/20), else NOT_SCREENED on a BOX bench, else
    bench_not_in_box. Novi's PUD / RES category is deliberately not read."""
    return (
        f"(CASE WHEN {a}.category = 'PDP' THEN NULL "
        "WHEN bp.coverage IS NOT NULL THEN bp.coverage "
        f"WHEN {a}.recon_status IN ('realized_drift', 'realized_phantom') THEN 'realized' "
        f"WHEN bsm.bench IS NOT NULL THEN '{NOT_SCREENED}' "
        "ELSE 'bench_not_in_box' END)"
    )


def tile_columns(a: str, econ_metrics: tuple[str, ...] = ()) -> str:
    """The BOX properties a Map tile carries per stick (select-list fragment over the
    box_joins / econ_join aliases). Rounded so the MVT value pool stays small; MVT drops
    NULL properties, so a not-covered stick simply has no EUR / econ property. Econ is
    only the whitelisted metrics the map asks for (the color metric + any econ range),
    one property `econ_<metric>` each, for one deck — never all nine by default."""
    cols = [
        f"{map_coverage_sql(a)} AS coverage",
        "bsw.tier AS water_tier",
        *(f"round((bs{s[0]}.eur_per_kft / 1000.0)::numeric, 1)::float8 AS {s}_eur_ft"
          for s in EUR_STREAMS),
        "bpp.outcome AS prox_outcome",
        "CASE WHEN bso.prox_factor < 1 THEN round(bso.prox_factor::numeric, 3)::float8 END AS prox_factor",
    ]
    for m in econ_metrics:
        col = ECON_METRICS[m]["col"]  # whitelisted: KeyError before any SQL
        cols.append(f"round(be.{col}::numeric, 2)::float8 AS econ_{m}")
    return ", ".join(cols)


def kind_sql(a: str) -> str:
    """PDP vs a Novi stick location. Novi's own PUD / RES tag is never shipped to the
    client (Michael 2026-10-21: only the stick geometry comes from Novi)."""
    return f"CASE WHEN {a}.category = 'PDP' THEN 'PDP' ELSE 'LOCATION' END"


def selection_columns(a: str, with_econ: bool) -> str:
    """Per-stick BOX values for an AOI selection / gunbarrel (select-list fragment over
    the box_joins / econ_join aliases). Units as stored: EUR bbl / mcf (raw 50-yr technical
    integral incl. the bench haircut and the D113 proximity factor), eur_per_kft per
    1,000 ft, `lat_basis_kft` = the lateral the stored per-kft used (eur / eur_per_kft), so
    a bench's per-ft is lateral-weighted: sum(eur) / sum(lat_basis). Econ = Steven's
    columns for the record run's case, $MM / % / $ per bbl, display only (D13). A location
    without a BOX forecast carries NULLs — never a zero."""
    cols = [
        f"{kind_sql(a)} AS kind",
        f"{map_coverage_sql(a)} AS coverage",
        "bsw.tier AS water_tier",
        *(f"bs{s[0]}.eur AS {s}_eur" for s in EUR_STREAMS),
        *(f"bs{s[0]}.eur_per_kft AS {s}_eur_per_kft" for s in EUR_STREAMS),
        "bso.eur / NULLIF(bso.eur_per_kft, 0) AS lat_basis_kft",
        "bpp.outcome AS prox_outcome",
        "CASE WHEN bso.prox_factor < 1 THEN bso.prox_factor END AS prox_factor",
    ]
    if with_econ:
        cols += [f"be.{m['col']} AS econ_{k}" for k, m in ECON_METRICS.items()]
        cols.append("be.unpriced_reason AS econ_unpriced_reason")
    return ", ".join(cols)


def econ_provenance(session: Session, run_id: int, case: dict[str, Any] | None) -> dict[str, Any] | None:
    """Provenance of the econ case shown (D13: displayed with provenance): deck, assumption
    set, prices, downtime basis, built / pushed. Cached with the cases."""
    if case is None:
        return None

    def q() -> dict[str, Any]:
        r = session.execute(text(
            "SELECT min(wti) AS wti, min(hh) AS hh, min(downtime_basis) AS downtime_basis, "
            "max(built_at) AS built_at, max(pushed_at) AS pushed_at, max(pushed_by) AS pushed_by, count(*) AS n_priced "
            "FROM box_econ.box_pud_econ WHERE run_id = :r AND deck_id = :d AND assumption_set_id = :a"),
            {"r": run_id, "d": case["deck_id"], "a": case["assumption_set_id"]}).mappings().one()
        out = {"deck_id": case["deck_id"], "assumption_set_id": case["assumption_set_id"], **dict(r)}
        for k in ("built_at", "pushed_at"):
            out[k] = out[k].isoformat() if out[k] is not None else None
        return out
    return _cached(("econ_prov", run_id, case["deck_id"], case["assumption_set_id"]), q)


def record_run(session: Session) -> dict[str, Any]:
    """The one BOX run marked is_record (sql/60 allows at most one)."""
    row = session.execute(
        text(
            "SELECT run_id, report_version, data_through, code_sha, engine_sha, dealintake_config, "
            "created_at, haircut, calendar_factor, disclosure, counts, notes "
            "FROM box.forecast_run WHERE is_record"
        )
    ).mappings().first()
    if row is None:
        raise HTTPException(503, "no BOX forecast run is marked as the record")
    r = dict(row)
    r["data_through"] = r["data_through"].isoformat()
    r["created_at"] = r["created_at"].isoformat()
    return r


# --- per-request lookups the tile endpoint would otherwise repeat for every tile -------
# A short TTL keeps a re-marked record run / a fresh econ push visible within a minute.
_TTL_S = 60.0
_cache: dict[tuple, tuple[float, Any]] = {}


def _cached(key: tuple, fn):  # noqa: ANN001, ANN202
    hit = _cache.get(key)
    now = time.monotonic()
    if hit is not None and now - hit[0] < _TTL_S:
        return hit[1]
    val = fn()
    _cache[key] = (now, val)
    return val


def record_run_id(session: Session) -> int | None:
    """run_id of the record run (None when no run is marked), cached for _TTL_S."""
    return _cached(("record_run_id",), lambda: session.execute(
        text("SELECT run_id FROM box.forecast_run WHERE is_record")).scalar())


def pick_econ_case(cases: list[dict[str, Any]], deck: str | None) -> dict[str, Any] | None:
    """The econ case to show from the record run's priced cases ({deck_id,
    assumption_set_id, built_at}): the requested deck, else DEFAULT_DECK, else the
    first; within a deck the most recently built assumption set. None = unpriced."""
    if not cases:
        return None
    want = deck if deck and any(c["deck_id"] == deck for c in cases) else None
    if want is None:
        want = DEFAULT_DECK if any(c["deck_id"] == DEFAULT_DECK for c in cases) else sorted(c["deck_id"] for c in cases)[0]
    same = [c for c in cases if c["deck_id"] == want]
    return max(same, key=lambda c: (c.get("built_at") is not None, c.get("built_at") or 0, c["assumption_set_id"]))


def econ_cases(session: Session, run_id: int) -> list[dict[str, Any]]:
    """Every priced (deck, assumption set) of the run, cached for _TTL_S."""
    return _cached(("econ_cases", run_id), lambda: [dict(r) for r in session.execute(
        text("SELECT deck_id, assumption_set_id, max(built_at) AS built_at "
             "FROM box_econ.box_pud_econ WHERE run_id = :r GROUP BY 1, 2"),
        {"r": run_id}).mappings().all()])


def econ_case(session: Session, run_id: int, deck: str | None) -> dict[str, Any] | None:
    """The record run's econ case for `deck` (see pick_econ_case); None = not priced."""
    return pick_econ_case(econ_cases(session, run_id), deck)
