"""Selection data gathering for the workbook export.

Split from the HTTP route on purpose: `gather_export_data` (queries) feeds
`assemble_export_data` (pure, no Session), and the result feeds
`xlsx_builder.build_workbook`. A future "graduate DSU to finance" workflow
can produce the same artifact by calling these directly — no HTTP involved.

The workbook covers PUD/RES only. PDP sticks in the selection are counted
(`pdp_count`, surfaced on the Assumptions tab) but excluded: their actuals
live in the warehouse by API10 and they have no Novi forecast here.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

import numpy as np
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.production import HORIZON_DAY, STEP, _tail_values

Rule = Literal["intersects", "midpoint"]
_PRED = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(w.wellstick_geom, 0.5))",
}

# Categories that carry a Novi forecast and make it into the workbook.
_FUTURE_CATS = ("PUD", "RES")

_DECK_KEYS = ("wti_price", "wti_diff", "hh_price", "hh_diff", "ngl_price")


class ExportBody(BaseModel):
    aoi: dict
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"
    exclude_wells: list[str] = []       # culled well names (unique_id)
    exclude_formations: list[str] = []  # formation_blueox codes turned off
    filename: str | None = None         # user-chosen workbook name (sans .xlsx)


@dataclass
class WellStream:
    """One well's full-life stream, aligned to ``ExportData.grid``.

    Rates are per-day (bopd / mcfd / bwpd). Days past ``forecast_end_day``
    are evaluated from the Arps segments (the tail).
    """

    name: str               # novi_wellname == unique_id
    formation: str          # Blue Ox formation_blueox code (the grouping dimension)
    forecast_end_day: int   # last Novi forecast ip_day
    oil: np.ndarray = field(repr=False, default=None)  # type: ignore[assignment]
    gas: np.ndarray = field(repr=False, default=None)  # type: ignore[assignment]
    water: np.ndarray = field(repr=False, default=None)  # type: ignore[assignment]


@dataclass
class ExportData:
    basin: str
    rule: str
    generated_at: datetime
    locations: list[dict]                # PUD/RES rows only, category/formation/name order
    pdp_count: int                       # PDP sticks in selection (not in workbook)
    excluded_formations: list[str]
    culled_count: int
    price_deck: dict                     # wti/hh/ngl price + diffs (flat, per snapshot)
    grid: list[int]                      # ip_day axis, 30 -> 18250 step 30
    streams_by_formation: dict[str, list[WellStream]]  # UPPER name -> name-sorted wells
    arps_rows: list[dict]                # arps segments + "formation" per row


def _included_names(loc_rows: list[dict]) -> list[str]:
    return sorted({
        r["unique_id"] for r in loc_rows
        if r.get("unique_id") and r.get("category") in _FUTURE_CATS
    })


def assemble_export_data(
    loc_rows: list[dict],
    prod_rows: list[dict],
    arps_rows: list[dict],
    *,
    basin: str,
    rule: str,
    excluded_formations: list[str],
    culled_count: int,
    generated_at: datetime | None = None,
) -> ExportData:
    """Pure assembly: filter to PUD/RES, stitch forecast + Arps tail per well.

    ``loc_rows`` may contain all categories (PDP is counted, then dropped).
    ``prod_rows``/``arps_rows`` are the raw query rows for the included wells.
    """
    pdp_count = sum(1 for r in loc_rows if r.get("category") == "PDP")
    locations = [r for r in loc_rows if r.get("category") in _FUTURE_CATS]
    # Group/label by Blue Ox standardized formation (formation_blueox); uncoded
    # wells fall under '(unmapped)'. Raw Novi `formation` stays on each loc row.
    formation_by_name = {
        r["unique_id"]: (r.get("formation_blueox") or "(unmapped)") for r in locations
    }

    fc_by_well: dict[str, list] = defaultdict(list)
    for r in prod_rows:
        fc_by_well[r["novi_wellname"]].append(r)
    seg_by: dict[tuple, list] = defaultdict(list)
    for r in arps_rows:
        seg_by[(r["novi_wellname"], r["production_stream"])].append(dict(r))

    # The grid is the union of every well's stitched days. Forecast data is
    # on 30-day steps, tails continue the same cadence, so this is normally
    # exactly range(30, 18250+1, 30) — the union form just keeps a well with
    # an off-cadence row from silently losing it.
    days: set[int] = set()
    per_well_days: dict[str, dict[int, tuple]] = {}
    forecast_end: dict[str, int] = {}
    for name in sorted(fc_by_well):
        if name not in formation_by_name:
            continue  # forecast row for a well not in the (filtered) selection
        fcs = fc_by_well[name]
        vals: dict[int, tuple] = {
            int(r["ip_day"]): (
                float(r["oil"] or 0.0), float(r["gas"] or 0.0), float(r["water"] or 0.0)
            )
            for r in fcs
        }
        last_day = max(vals)
        forecast_end[name] = last_day
        tail_days = list(range(last_day + STEP, HORIZON_DAY + 1, STEP))
        if tail_days:
            tarr = np.asarray(tail_days, dtype=float)
            o = _tail_values(seg_by.get((name, "oil"), []), tarr)
            g = _tail_values(seg_by.get((name, "gas"), []), tarr)
            w = _tail_values(seg_by.get((name, "water"), []), tarr)
            for k, d in enumerate(tail_days):
                vals[d] = (float(o[k]), float(g[k]), float(w[k]))
        per_well_days[name] = vals
        days.update(vals)

    grid = sorted(days)
    idx = {d: i for i, d in enumerate(grid)}
    n = len(grid)

    streams_by_formation: dict[str, list[WellStream]] = defaultdict(list)
    for name, vals in per_well_days.items():
        oil = np.zeros(n)
        gas = np.zeros(n)
        water = np.zeros(n)
        for d, (o, g, w) in vals.items():
            i = idx[d]
            oil[i], gas[i], water[i] = o, g, w
        streams_by_formation[formation_by_name[name]].append(
            WellStream(
                name=name,
                formation=formation_by_name[name],
                forecast_end_day=forecast_end[name],
                oil=oil,
                gas=gas,
                water=water,
            )
        )
    for wells in streams_by_formation.values():
        wells.sort(key=lambda ws: ws.name)

    included = set(formation_by_name)
    arps_out = [
        {**dict(r), "formation": formation_by_name[r["novi_wellname"]]}
        for r in arps_rows
        if r["novi_wellname"] in included
    ]

    deck_row = locations[0] if locations else {}
    return ExportData(
        basin=basin,
        rule=rule,
        generated_at=generated_at or datetime.now(timezone.utc),
        locations=locations,
        pdp_count=pdp_count,
        excluded_formations=list(excluded_formations),
        culled_count=culled_count,
        price_deck={k: deck_row.get(k) for k in _DECK_KEYS},
        grid=grid,
        streams_by_formation=dict(sorted(streams_by_formation.items())),
        arps_rows=arps_out,
    )


def gather_export_data(session: Session, body: ExportBody) -> ExportData:
    """Run the selection queries and assemble the export payload."""
    pred = _PRED[body.rule]
    params = {
        "aoi": json.dumps(body.aoi),
        "basin": body.basin,
        "xforms": body.exclude_formations,
        "xwells": body.exclude_wells,
    }

    # Included locations: full curated row (minus geom) as JSON -> dict.
    # All categories — PDP is needed for the Assumptions-tab count.
    loc_rows = session.execute(
        text(f"""
            WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g)
            SELECT to_jsonb(w) - 'wellstick_geom'
                   || jsonb_build_object('formation_blueox',
                                         COALESCE(fb.formation_blueox, '(unmapped)')) AS r
            FROM curated.intel_locations w
            LEFT JOIN curated.intel_formation_blueox fb ON fb.stick_id = w.stick_id, aoi
            WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL AND {pred}
              AND COALESCE(fb.formation_blueox, '(unmapped)') <> ALL((:xforms)::text[])
              AND w.unique_id <> ALL((:xwells)::text[])
            ORDER BY w.category, COALESCE(fb.formation_blueox, '(unmapped)'), w.unique_id
        """),
        params,
    ).scalars().all()
    locations = list(loc_rows)
    names = _included_names(locations)

    prod_rows = session.execute(
        text("""
            SELECT novi_wellname, ip_day, oil, gas, water
            FROM curated.intel_forecast
            WHERE basin = :basin AND novi_wellname = ANY((:names)::text[])
            ORDER BY novi_wellname, ip_day
        """),
        {"basin": body.basin, "names": names},
    ).mappings().all()
    arps_rows = session.execute(
        text("""
            SELECT novi_wellname, production_stream, segment, segment_curve_type,
                   b, d_nom, d_eff_secant, d_eff_tangent, q_start, q_stop,
                   terminal_day, day_start, day_stop
            FROM curated.intel_arps
            WHERE basin = :basin AND novi_wellname = ANY((:names)::text[])
            ORDER BY novi_wellname, production_stream, segment
        """),
        {"basin": body.basin, "names": names},
    ).mappings().all()

    return assemble_export_data(
        locations,
        [dict(r) for r in prod_rows],
        [dict(r) for r in arps_rows],
        basin=body.basin,
        rule=body.rule,
        excluded_formations=body.exclude_formations,
        culled_count=len(body.exclude_wells),
    )
