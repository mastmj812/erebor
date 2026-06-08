"""Authoritative export: the current selection (AOI + rule), minus excluded
formations and manually-culled wells, packaged as a ZIP of CSVs for the user's
downstream economic model.

  locations.csv         one row per included stick (metadata + EUR + Novi economics)
  production_monthly.csv Novi forecast streams for included PUD/RES wells
  arps.csv              decline params for those wells (to reproduce the 50-yr tail)
  summary.csv           rollup by category x formation (reconciles with the app)
  README.txt            schema + keys + caveat

Economics in here are Novi's pre-computed numbers on one flat price deck — a
screen. The point of the export is to feed YOUR model.
"""

from __future__ import annotations

import csv
import io
import json
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.production import HORIZON_DAY, STEP, _tail_values
from app.db import get_session

router = APIRouter(prefix="/export", tags=["export"])

Rule = Literal["intersects", "midpoint"]
_PRED = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(w.wellstick_geom, 0.5))",
}


class ExportBody(BaseModel):
    aoi: dict
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"
    exclude_wells: list[str] = []       # culled well names (unique_id)
    exclude_formations: list[str] = []  # UPPER formation names turned off


def _csv_bytes(fieldnames: list[str], rows: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


@router.post("")
def export(body: ExportBody, session: Session = Depends(get_session)) -> StreamingResponse:
    pred = _PRED[body.rule]
    params = {
        "aoi": json.dumps(body.aoi),
        "basin": body.basin,
        "xforms": body.exclude_formations,
        "xwells": body.exclude_wells,
    }

    # 1) Included locations: full curated row (minus geom) as JSON -> dict.
    loc_rows = session.execute(
        text(f"""
            WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g)
            SELECT to_jsonb(w) - 'wellstick_geom' AS r
            FROM curated.intel_locations w, aoi
            WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL AND {pred}
              AND UPPER(w.formation) <> ALL((:xforms)::text[])
              AND w.unique_id <> ALL((:xwells)::text[])
            ORDER BY w.category, w.formation, w.unique_id
        """),
        params,
    ).scalars().all()
    locations = [r for r in loc_rows]  # each r is a dict (jsonb)
    names = sorted({r["unique_id"] for r in locations if r.get("unique_id")})

    # 2) Forecast streams + 3) Arps params for the included wells (PUD/RES join by name).
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

    # 3b) Stitch each well's forecast + evaluated Arps tail into a full-life
    #     (0 -> 18,250 day = 50 yr) per-day-rate stream for the downstream model.
    fc_by_well: dict[str, list] = defaultdict(list)
    for r in prod_rows:
        fc_by_well[r["novi_wellname"]].append(r)
    seg_by: dict[tuple, list] = defaultdict(list)
    for r in arps_rows:
        seg_by[(r["novi_wellname"], r["production_stream"])].append(dict(r))
    prod_out: list[dict] = []
    for name in names:
        fcs = fc_by_well.get(name)
        if not fcs:  # PDP (api10) has no Novi forecast -> not in the stream
            continue
        for r in fcs:
            prod_out.append({"novi_wellname": name, "ip_day": r["ip_day"], "oil": r["oil"],
                             "gas": r["gas"], "water": r["water"], "source": "forecast"})
        last_day = max(int(r["ip_day"]) for r in fcs)
        tail_days = list(range(last_day + STEP, HORIZON_DAY + 1, STEP))
        if tail_days:
            tarr = np.asarray(tail_days, dtype=float)
            o = _tail_values(seg_by.get((name, "oil"), []), tarr)
            g = _tail_values(seg_by.get((name, "gas"), []), tarr)
            w = _tail_values(seg_by.get((name, "water"), []), tarr)
            for k, d in enumerate(tail_days):
                prod_out.append({"novi_wellname": name, "ip_day": d,
                                 "oil": round(float(o[k]), 3), "gas": round(float(g[k]), 3),
                                 "water": round(float(w[k]), 3), "source": "arps_tail"})

    # 4) Summary rollup by (category, formation): count + NPV/PV/EUR sums.
    SUMS = ("npv5", "npv10", "npv15", "npv20", "npv25",
            "pv5", "pv10", "pv15", "pv20", "pv25", "oil_eur", "gas_eur")
    groups: dict[tuple, dict] = {}
    cat_count: Counter = Counter()
    for r in locations:
        cat_count[r["category"]] += 1
        key = (r["category"], r["formation"])
        g = groups.setdefault(key, {"count": 0, **{c: 0.0 for c in SUMS}})
        g["count"] += 1
        for c in SUMS:
            g[c] += float(r.get(c) or 0.0)
    summary_rows = [
        {"category": c, "formation": f, **{k: round(v, 2) if isinstance(v, float) else v
                                           for k, v in vals.items()}}
        for (c, f), vals in sorted(groups.items())
    ]

    # ---- package the zip ----
    # to_jsonb reorders keys by length, so impose a readable column order:
    # keys -> geology/completion -> reserves -> economics -> deck; rest appended.
    LOC_ORDER = [
        "unique_id", "api10", "category", "formation", "operator", "county",
        "pad_name", "basin", "fp_year", "subbasin",
        "tvd", "md", "ll_ft", "prop_load",
        "oil_eur", "gas_eur", "dgas_eur", "ngl_eur", "water_eur",
        "oil_ip", "gas_ip", "dgas_ip", "ngl_ip", "water_ip", "ngl_yield", "ngl_shrink",
        "npv5", "npv10", "npv15", "npv20", "npv25",
        "pv5", "pv10", "pv15", "pv20", "pv25",
        "npv5_be", "npv10_be", "npv15_be", "npv20_be", "npv25_be",
        "be_1yr", "be_2yr", "be_3yr", "irr_pct", "irr_pct_raw", "pp_months", "ttpt",
        "dc_cost", "dcet_cost", "norm_dc", "norm_dcet",
        "wti_price", "hh_price", "ngl_price", "wti_diff", "hh_diff",
        "has_econ", "conf_int", "pdp_in_warehouse",
        "heel_lat", "heel_lon", "midpoint_lat", "midpoint_lon", "bh_lat", "bh_lon",
        "stick_id", "src_layer", "report_version", "phase",
    ]
    keys = set(locations[0].keys()) if locations else {"unique_id"}
    loc_fields = [c for c in LOC_ORDER if c in keys] + sorted(keys - set(LOC_ORDER))
    deck = locations[0] if locations else {}
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    readme = f"""erebor export — {body.basin.title()} basin
Generated: {now}

Selection rule: {body.rule}
Included locations: {len(locations)}  (PDP {cat_count.get('PDP', 0)} / PUD {cat_count.get('PUD', 0)} / RES {cat_count.get('RES', 0)})
Excluded formations: {', '.join(body.exclude_formations) or '(none)'}
Manually culled wells: {len(body.exclude_wells)}
Price deck (flat): WTI {deck.get('wti_price')} (diff {deck.get('wti_diff')}) | HH {deck.get('hh_price')} (diff {deck.get('hh_diff')}) | NGL {deck.get('ngl_price')}

FILES
  locations.csv          one row per included stick. Key: unique_id (PUD/RES = Novi
                         well name; PDP = API10). api10 joins PDP to your warehouse.
                         irr_pct is normalized to PERCENT; *_raw is Novi's source value.
  production_monthly.csv FULL-LIFE per-day-rate stream per PUD/RES well, ip_day 30 ->
                         18250 (50 yr). Novi ML forecast (source=forecast, ~29.5 yr)
                         stitched to the evaluated Arps tail (source=arps_tail). 30-day
                         steps; monthly volume ~= rate * 30. Join on novi_wellname. PDP
                         wells are not here (their actuals live in the warehouse by API10).
  arps.csv               segmented Arps params per well/stream (the source for the tail
                         above; final exponential segment runs to day_stop=18250).
  summary.csv            rollup by category x formation (count + NPV/PV at each discount
                         rate + EUR). Reconciles with the in-app screen.

CAVEAT: economics here are Novi's pre-computed values on a single flat price deck —
a screening number, not a valuation. Run your own model off these inputs.
"""

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("locations.csv", _csv_bytes(loc_fields, locations))
        z.writestr("production_monthly.csv",
                   _csv_bytes(["novi_wellname", "ip_day", "oil", "gas", "water", "source"],
                              prod_out))
        z.writestr("arps.csv",
                   _csv_bytes(["novi_wellname", "production_stream", "segment",
                               "segment_curve_type", "b", "d_nom", "d_eff_secant",
                               "d_eff_tangent", "q_start", "q_stop", "terminal_day",
                               "day_start", "day_stop"],
                              [dict(r) for r in arps_rows]))
        z.writestr("summary.csv",
                   _csv_bytes(["category", "formation", "count", *SUMS], summary_rows))
        z.writestr("README.txt", readme.encode("utf-8"))
    out.seek(0)

    fname = f"erebor_{body.basin}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M')}.zip"
    return StreamingResponse(
        out, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
