"""Gunbarrel cross-section data for an AOI selection.

Projects EVERY selected lateral onto ONE shared axis perpendicular to the
selection's mean lateral azimuth (horizontal offset, ft) and pairs it with TVD —
the classic gunbarrel view looking down the laterals, as a single cross-section.

A single shared frame (not one panel per pad / unit) is deliberate: trellising by a
unit assignment scatters physically co-located wells across panels. One frame puts a
producer and the locations it overlaps side by side.

Assumes the selection is roughly parallel laterals (one azimuth) — true for a
box/lasso over a development area; a selection spanning two differently-oriented
areas will skew the offset. No pad resolution, so no well is dropped.

One point per LEG (BOX sticks cutover): a location is a BOX stick, and a U-turn stick has
two producing legs side by side — two points with the same stick_id (`leg_no` 1 and 2 of
`n_legs` 2), each at its own leg's midpoint and the stick's landing TVD. The legs come from
the basin's record stick set through app.box_locations.leg_join; a producing well is its
own one leg. The frame's mean lateral direction is AXIAL: the two legs of a U-turn run
opposite ways, and producers are drilled both ways too, so every heel->toe vector is
turned to agree with the first before summing (opposite vectors would cancel).

BOX-first (overhaul step 4): each location carries its BOX record-run coverage, per-ft
EUR per stream and — with `econ` + `deck` — ONE of Steven's econ columns for the record
run's case (display only, D13), all through app.box_locations. `category` is
PDP | LOCATION (the client hides no-BOX-forecast locations like the map does). A U-turn
stick's values are the stick's, repeated on both of its points.
"""

from __future__ import annotations

import json
import math
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.box_locations import (
    ECON_METRICS,
    EUR_STREAMS,
    LEG_COLUMNS,
    box_joins,
    econ_case,
    econ_join,
    kind_sql,
    leg_join,
    map_coverage_sql,
    record_run_id,
)
from app.db import get_session

router = APIRouter(prefix="/gunbarrel", tags=["gunbarrel"])

Rule = Literal["intersects", "midpoint"]
# The AOI test stays on w.wellstick_geom (the GiST-indexed column) for both rules; `midpoint`
# then keeps the legs whose OWN midpoint is inside (leg_join's g.geom — for a producing well
# that is its wellstick; the midpoint of a U-turn stick's one line would sit on the turn arc).
_PRED = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": ("ST_Intersects(w.wellstick_geom, aoi.g) "
                 "AND ST_Contains(aoi.g, ST_LineInterpolatePoint(g.geom, 0.5))"),
}
M_PER_DEG_LAT = 110540.0
M_PER_DEG_LON = 111320.0
FT_PER_M = 3.28084


def _canonical_axis(perp: tuple[float, float]) -> tuple[tuple[float, float], str, str]:
    """Canonicalize the cross-section axis to the suite-wide gunbarrel reading
    (same rule as anduin's dossier/inspect charts and narvi's panel): a ~N-S
    lateral set (axis runs E-W) reads W -> E, a ~E-W set (axis runs N-S) reads
    S -> N (sign rule v2, Michael 2026-10-08: + points into the NE half; a
    perfect 45° tie goes to the E-W branch). The mean heel->toe direction is
    data-order arbitrary, so the
    DOMINANT compass component of the perpendicular decides and the sign flips
    to match. Copy-shared with highgrade.py / accuracy.py (like the projection
    constants). Returns (axis, left_label, right_label)."""
    px, py = perp  # (east, north) components
    if abs(px) >= abs(py):  # axis runs E-W: +offset = East
        return ((-px, -py) if px < 0 else (px, py)), "W", "E"
    return ((-px, -py) if py < 0 else (px, py)), "S", "N"  # +offset = North


class GbBody(BaseModel):
    aoi: dict
    basin: Literal["delaware", "midland"]
    rule: Rule = "intersects"
    econ: str | None = Field(None, pattern="^(" + "|".join(ECON_METRICS) + ")$")
    deck: str | None = Field(None, max_length=64)


def gunbarrel_sql(rule: Rule, econ_metric: str | None) -> str:
    """One row per LEG of every lateral the AOI selects (binds :aoi :basin :box_run, plus
    the econ case with a metric)."""
    econ_col = f", be.{ECON_METRICS[econ_metric]['col']} AS econ" if econ_metric else ""
    eur_cols = ", ".join(f"bs{s[0]}.eur_per_kft / 1000.0 AS {s}_eur_ft" for s in EUR_STREAMS)
    return f"""
            WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g)
            SELECT w.stick_id, w.unique_id, {kind_sql("w")} AS category, UPPER(w.formation) AS formation,
                   w.formation_blueox, w.basin_blueox, w.formation_blueox_source,
                   {map_coverage_sql("w")} AS coverage, {eur_cols},
                   bpp.outcome AS prox_outcome{econ_col},
                   w.tvd, w.ll_ft,
                   {LEG_COLUMNS}
            FROM curated.erebor_locations w
            CROSS JOIN aoi
            {box_joins("w", bench="w.formation_blueox")}
            {econ_join() if econ_metric else ""}
            {leg_join("w")}
            WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL
              AND w.tvd IS NOT NULL AND {_PRED[rule]}
            ORDER BY w.stick_id, g.path[1]
        """


@router.post("")
def gunbarrel(body: GbBody, session: Session = Depends(get_session)) -> dict:
    run_id = record_run_id(session, body.basin)
    case = econ_case(session, run_id, body.deck) if (body.econ and run_id is not None) else None
    econ_metric = body.econ if case is not None else None
    params = {"aoi": json.dumps(body.aoi), "basin": body.basin, "box_run": run_id}
    if case is not None:
        params |= {"econ_deck": case["deck_id"], "econ_aset": case["assumption_set_id"]}
    rows = session.execute(text(gunbarrel_sql(body.rule, econ_metric)), params).mappings().all()

    if not rows:
        return {"pad_count": 0, "pads": []}

    # One frame for the whole selection: shared centroid + a single offset axis
    # perpendicular to the (axial) mean heel->toe azimuth of every leg.
    perp, axis_left, axis_right, cx, cy, mids = _frame(rows)

    wells = []
    for r, (mxm, mym) in zip(rows, mids):
        offset_ft = ((mxm - cx) * perp[0] + (mym - cy) * perp[1]) * FT_PER_M
        wells.append({
            "stick_id": r["stick_id"],
            "unique_id": r["unique_id"], "category": r["category"],
            "formation": r["formation"],
            "formation_blueox": r["formation_blueox"],
            "basin_blueox": r["basin_blueox"],
            "formation_blueox_source": r["formation_blueox_source"],
            "coverage": r["coverage"],  # BOX record-run class; NULL on PDP
            **{f"{s}_eur_ft": (float(r[f"{s}_eur_ft"]) if r[f"{s}_eur_ft"] is not None else None)
               for s in EUR_STREAMS},
            "prox_outcome": r["prox_outcome"],
            "econ": float(r["econ"]) if econ_metric and r["econ"] is not None else None,
            "tvd": float(r["tvd"]),
            "ll_ft": float(r["ll_ft"]) if r["ll_ft"] is not None else None,  # the STICK's lateral (both legs of a U-turn)
            "leg_no": int(r["leg_no"]), "n_legs": int(r["n_legs"]),
            "offset_ft": round(offset_ft, 1),
        })
    wells.sort(key=lambda x: (x["offset_ft"], x["stick_id"], x["leg_no"]))
    pad = {
        # well_count = points (one per leg); stick_count = distinct sticks / wells
        "pad_name": "Selection", "well_count": len(wells),
        "stick_count": len({w["stick_id"] for w in wells}),
        "axis_left": axis_left, "axis_right": axis_right,
        "wells": wells,
    }
    return {"pad_count": 1, "pads": [pad]}


def axial_sum(vectors):  # noqa: ANN001, ANN201
    """Sum of heel->toe vectors as UNDIRECTED lines: each is turned to have a non-negative
    dot product with the first before it is added, so the opposite legs of a U-turn stick
    (and producers drilled the other way) reinforce the direction instead of cancelling it."""
    dx = dy = 0.0
    ref = None
    for vx, vy in vectors:
        if ref is None:
            ref = (vx, vy)
        elif vx * ref[0] + vy * ref[1] < 0:
            vx, vy = -vx, -vy
        dx += vx
        dy += vy
    return dx, dy


def _frame(rows):  # noqa: ANN001, ANN202
    """The selection's frame from rows carrying sx/sy, ex/ey, mx/my (lon/lat): the canonical
    offset axis (perpendicular to the axial mean lateral direction), the centroid of the
    midpoints, and each row's midpoint, in a local metre projection."""
    lat0 = sum(r["my"] for r in rows) / len(rows)
    lon0 = sum(r["mx"] for r in rows) / len(rows)
    k = math.cos(math.radians(lat0))

    def to_m(lon, lat):
        return ((lon - lon0) * M_PER_DEG_LON * k, (lat - lat0) * M_PER_DEG_LAT)

    vecs = []
    mids = []
    for r in rows:
        sxm, sym = to_m(r["sx"], r["sy"])
        exm, eym = to_m(r["ex"], r["ey"])
        vecs.append((exm - sxm, eym - sym))
        mids.append(to_m(r["mx"], r["my"]))
    dx, dy = axial_sum(vecs)
    norm = math.hypot(dx, dy)
    if norm < 1e-9:
        perp = (1.0, 0.0)
    else:
        ux, uy = dx / norm, dy / norm
        perp = (-uy, ux)  # rotate the mean lateral direction 90deg
    perp, axis_left, axis_right = _canonical_axis(perp)
    cx = sum(m[0] for m in mids) / len(mids)
    cy = sum(m[1] for m in mids) / len(mids)
    return perp, axis_left, axis_right, cx, cy, mids
