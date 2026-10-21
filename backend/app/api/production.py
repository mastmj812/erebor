"""Production profiles.

  * POST /production/box_profile : the BOX record run's monthly volumes for the
    forecast-carrying locations in an AOI, per Blue Ox bench: the field SUM and the
    cohort MEAN per 1,000 ft (rule 18: a mean, never labelled P50; locations without
    a lateral basis drop from numerator AND denominator). Exact monthly integrals,
    uptime-free (D39 / D63), 600 months, so a bench's months sum to its stored EUR.
    Validated vs PROVISIONAL counts per bench (D105); water carries its own tier.
    Replaces the Novi aggregate (overhaul step 4: Novi's forecast survives only as the
    single-well comparison below).
  * GET  /production/well        : one well's Novi forecast stream + Arps tail to 50 yr
    (the comparison curve), plus its BOX record-run forecast under `box`.

Forecast/Arps are keyed by novi_wellname (= PUD/RES Unique ID). /well also carries the
BOX record run's forecast for that PUD when one exists (app/api/box.well_forecast). PDP sticks are
API-keyed and absent from the Novi forecast, so they don't contribute here (their
actuals live in curated.production — a later addition if wanted).
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.box import well_forecast
from app.box_locations import FORECAST_IN_SQL, record_run
from app.db import get_session
from decline.models import arps_exponential, arps_hyperbolic

router = APIRouter(prefix="/production", tags=["production"])

Rule = Literal["intersects", "midpoint"]
_PRED = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(w.wellstick_geom, 0.5))",
}
HORIZON_DAY = 18250  # 50 yr
STEP = 30


def _seg_decline_per_year(seg) -> float:
    """Nominal decline per year for one Novi Arps segment.

    Novi ships `d_nom = NULL` on EVERY terminal exponential segment (both
    basins, both vintages — verified 2026-09-17); on those rows the decline
    hides in `d_eff_tangent` in PER-DAY units, unlike segments 1-2 where the
    same column is per-year. Rather than trust mixed-unit columns, derive the
    decline from the segment's own endpoints: ln(q_start/q_stop) over the
    segment span. Coalescing NULL->0 here (the pre-2026-09-17 behavior) made
    every tail run FLAT at the terminal q_start from ~month 360 on, inflating
    long-horizon cums in the aggregate panel (and the since-retired xlsx export).
    """
    d = seg["d_nom"]
    if d is not None:
        return float(d)
    q_start = float(seg["q_start"] or 0.0)
    q_stop = float(seg["q_stop"] or 0.0)
    span_days = float(seg["day_stop"] or 0.0) - float(seg["day_start"] or 0.0)
    if q_start > 0.0 and q_stop > 0.0 and span_days > 0.0:
        return math.log(q_start / q_stop) * 365.0 / span_days
    return 0.0


def _tail_values(segs: list, days_arr: np.ndarray) -> np.ndarray:
    """Vectorized rate at each tail day, using whichever segment covers it.

    Decline is nominal per year (see `_seg_decline_per_year` for the NULL
    terminal-segment derivation); t is years since the segment start.
    decline.models functions are numpy-vectorized, so we evaluate a whole
    segment's day-slice at once. Days covered by no segment stay 0.
    """
    out = np.zeros(days_arr.shape, dtype=float)
    for seg in segs:
        mask = (days_arr >= seg["day_start"]) & (days_arr <= seg["day_stop"])
        if not mask.any():
            continue
        t = (days_arr[mask] - seg["day_start"]) / 365.0
        qi = float(seg["q_start"] or 0.0)
        di = _seg_decline_per_year(seg)
        b = float(seg["b"] or 0.0)
        if seg["segment_curve_type"] == "exponential" or b < 1e-6:
            out[mask] = arps_exponential(t, qi, di)
        else:
            out[mask] = arps_hyperbolic(t, qi, di, b)
    return out


def _anchored_tail(
    segs: list, days_arr: np.ndarray, last_day: float, last_rate: float
) -> np.ndarray:
    """Arps tail scaled so its level continues the forecast's own end.

    Novi's monthly forecast rows sit ~13-15% BELOW their own Arps curve in
    the terminal region (same decline slope — their calendar-day/uptime
    factor is applied to the monthly series but not the ideal-rate Arps
    params), so a raw segment evaluation steps UP at the seam. Use the
    segments for SHAPE and the last forecast rate for LEVEL: scale by
    last_rate / arps(last_day). No scaling when either side is
    non-positive (no forecast, or no segment covering the seam).
    """
    tv = _tail_values(segs, days_arr)
    if last_rate > 0.0:
        seam = float(_tail_values(segs, np.asarray([float(last_day)]))[0])
        if seam > 0.0:
            tv = tv * (last_rate / seam)
    return tv


BOX_MONTHS = 600  # box.pud_forecast_month.month_no 1..600 (50 yr, D16 / D39)
STREAMS = ("oil", "gas", "water")


class ProfileBody(BaseModel):
    aoi: dict
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"
    exclude_sticks: list[int] = []          # culled stick_ids
    formations: list[str] = []              # bench include filter (empty = all); '(unmapped)' allowed
    tiers: list[Literal["validated", "provisional"]] = ["validated", "provisional"]


def profile_sql(rule: Rule) -> str:
    """The AOI's forecast-carrying BOX locations (sel) -> per (bench, stream, month)
    volume SUM and SUM of volume per 1,000 ft. The lateral basis is the one the stored
    eur_per_kft used (eur / eur_per_kft), so mean-per-kft x lateral == the location."""
    return f"""
        WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g),
        sel AS (
          SELECT bp.location_id, COALESCE(w.formation_blueox, '(unmapped)') AS formation, bp.coverage,
                 bso.eur / NULLIF(bso.eur_per_kft, 0) AS lat_kft
          FROM curated.erebor_locations w
          CROSS JOIN aoi
          JOIN box.pud_forecast bp ON bp.run_id = :box_run AND bp.stick_id = w.stick_id
          JOIN box.pud_forecast_stream bso ON bso.run_id = bp.run_id AND bso.location_id = bp.location_id
                                          AND bso.stream = 'oil'
          WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL AND {_PRED[rule]}
            AND bp.coverage IN {FORECAST_IN_SQL}
            AND bp.coverage = ANY(CAST(:coverages AS text[]))
            AND w.stick_id <> ALL(CAST(:exclude AS bigint[]))
            AND (cardinality(CAST(:formations AS text[])) = 0
                 OR COALESCE(w.formation_blueox, '(unmapped)') = ANY(CAST(:formations AS text[])))
        )
        SELECT s.formation, m.stream, m.month_no,
               SUM(m.volume) AS vol,
               SUM(m.volume / s.lat_kft) FILTER (WHERE s.lat_kft > 0) AS vol_per_kft
        FROM sel s
        JOIN box.pud_forecast_month m ON m.run_id = :box_run AND m.location_id = s.location_id
        GROUP BY 1, 2, 3
    """


def counts_sql(rule: Rule) -> str:
    return profile_sql(rule).split("SELECT s.formation, m.stream")[0] + """
        SELECT s.formation,
               count(*) AS n,
               count(*) FILTER (WHERE s.coverage = 'covered') AS n_validated,
               count(*) FILTER (WHERE s.coverage = 'covered_provisional') AS n_provisional,
               count(*) FILTER (WHERE s.lat_kft > 0) AS n_kft,
               count(*) FILTER (WHERE bsw.tier = 'provisional') AS n_water_provisional
        FROM sel s
        LEFT JOIN box.pud_forecast_stream bsw ON bsw.run_id = :box_run AND bsw.location_id = s.location_id
                                             AND bsw.stream = 'water'
        GROUP BY 1
    """


def bench_tier(n_validated: int, n_provisional: int) -> str:
    return "provisional" if n_validated == 0 else "validated" if n_provisional == 0 else "mixed"


@router.post("/box_profile")
def box_profile(body: ProfileBody, session: Session = Depends(get_session)) -> dict:
    run = record_run(session)
    coverages = [{"validated": "covered", "provisional": "covered_provisional"}[t] for t in body.tiers]
    params = {"aoi": json.dumps(body.aoi), "basin": body.basin, "box_run": run["run_id"],
              "coverages": coverages, "exclude": body.exclude_sticks, "formations": body.formations}
    counts = {r["formation"]: dict(r) for r in session.execute(text(counts_sql(body.rule)), params).mappings()}
    benches: dict[str, dict] = {}
    for f, c in counts.items():
        benches[f] = {
            "formation": f, "n": int(c["n"]), "n_validated": int(c["n_validated"]),
            "n_provisional": int(c["n_provisional"]), "n_lateral": int(c["n_kft"]),
            "n_water_provisional": int(c["n_water_provisional"]),
            "tier": bench_tier(int(c["n_validated"]), int(c["n_provisional"])),
            "sum": {st: [0.0] * BOX_MONTHS for st in STREAMS},
            "per_kft_mean": {st: [0.0] * BOX_MONTHS for st in STREAMS},
        }
    for r in session.execute(text(profile_sql(body.rule)), params).mappings():
        b = benches.get(r["formation"])
        k = int(r["month_no"]) - 1
        if b is None or r["stream"] not in STREAMS or not 0 <= k < BOX_MONTHS:
            continue
        b["sum"][r["stream"]][k] = float(r["vol"] or 0.0)
        if b["n_lateral"]:
            b["per_kft_mean"][r["stream"]][k] = float(r["vol_per_kft"] or 0.0) / b["n_lateral"]
    return {
        "box_run": {"run_id": run["run_id"], "data_through": run["data_through"]},
        "months": BOX_MONTHS,
        "benches": sorted(benches.values(), key=lambda b: -b["n"]),
    }


@router.get("/well")
def well(
    name: str = Query(...),
    basin: Literal["delaware", "midland"] = Query(...),
    session: Session = Depends(get_session),
) -> dict:
    """One well's forecast stream + the Arps tail evaluated to 50 yr, plus the BOX
    record run's forecast for the same PUD under `box` (None for a non-PUD; for a PUD
    BOX does not cover, just its coverage class — shown, never zero)."""
    fc = session.execute(
        text("""
            SELECT ip_day, oil, gas, water FROM curated.intel_forecast
            WHERE basin = :basin AND novi_wellname = :name ORDER BY ip_day
        """),
        {"basin": basin, "name": name},
    ).mappings().all()
    forecast = {
        "ip_day": [r["ip_day"] for r in fc],
        "oil": [float(r["oil"] or 0) for r in fc],
        "gas": [float(r["gas"] or 0) for r in fc],
        "water": [float(r["water"] or 0) for r in fc],
    }
    last_day = fc[-1]["ip_day"] if fc else 0

    segs = session.execute(
        text("""
            SELECT production_stream, segment_curve_type, b, d_nom,
                   q_start, q_stop, day_start, day_stop
            FROM curated.intel_arps
            WHERE basin = :basin AND novi_wellname = :name
            ORDER BY production_stream, segment
        """),
        {"basin": basin, "name": name},
    ).mappings().all()
    by_stream: dict[str, list] = defaultdict(list)
    for s in segs:
        by_stream[s["production_stream"]].append(s)

    tail_days = list(range(int(last_day) + STEP, HORIZON_DAY + 1, STEP))
    tail_arr = np.asarray(tail_days, dtype=float)
    tail = {
        "ip_day": tail_days,
        "oil": _anchored_tail(
            by_stream.get("oil", []), tail_arr, float(last_day),
            forecast["oil"][-1] if forecast["oil"] else 0.0,
        ).tolist(),
        "gas": _anchored_tail(
            by_stream.get("gas", []), tail_arr, float(last_day),
            forecast["gas"][-1] if forecast["gas"] else 0.0,
        ).tolist(),
        "water": _anchored_tail(
            by_stream.get("water", []), tail_arr, float(last_day),
            forecast["water"][-1] if forecast["water"] else 0.0,
        ).tolist(),
    }
    return {
        "name": name, "forecast": forecast,
        "forecast_end_day": last_day, "arps_tail": tail,
        "has_forecast": len(fc) > 0,
        "box": well_forecast(session, basin, name),
    }
