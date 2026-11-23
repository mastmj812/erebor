"""Gunbarrel cross-section data for an AOI selection.

Projects EVERY selected lateral onto ONE shared axis perpendicular to the
selection's mean lateral azimuth (horizontal offset, ft) and pairs it with TVD —
the classic gunbarrel view looking down the laterals, as a single cross-section.

A single shared frame (not one panel per Novi pad/unit) is deliberate: Novi names
PUDs per planned well and buckets producers into pad polygons, so trellising by
that assignment scatters physically co-located wells across panels — exactly the
wells the §6 reconciliation matches ACROSS unit names. One frame puts a producer
and the PUDs it overlaps side by side.

Assumes the selection is roughly parallel laterals (one azimuth) — true for a
box/lasso over a development area; a selection spanning two differently-oriented
areas will skew the offset. Uses wellstick_geom (present for all categories);
no pad resolution, so no well is dropped.

BOX-first (overhaul step 4): each location carries its BOX record-run coverage, per-ft
EUR per stream and — with `econ` + `deck` — ONE of Steven's econ columns for the record
run's case (display only, D13), all through app.box_locations. Novi supplies only the
geometry: `category` is PDP | LOCATION, and Novi's recon / depletion / support screens
are gone (the client hides no-BOX-forecast locations like the map does).

BOX sticks PREVIEW (`box_sticks: true`; engineering_db docs/box_sticks_plan.md, phase 5e): the
basin's record BOX stick set in the same AOI, one point per leg at its landing TVD, in a
separate `box_sticks` list on the pad. They are projected onto the frame the existing rows
define — they never move the axis, the centroid, `wells` or `well_count` — and carry no
forecast and no econ. Without the flag the response is exactly what it was.
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
    box_joins,
    box_stick_gunbarrel_sql,
    econ_case,
    econ_join,
    kind_sql,
    map_coverage_sql,
    record_run_id,
)
from app.db import get_session

router = APIRouter(prefix="/gunbarrel", tags=["gunbarrel"])

Rule = Literal["intersects", "midpoint"]
_PRED = {
    "intersects": "ST_Intersects(w.wellstick_geom, aoi.g)",
    "midpoint": "ST_Contains(aoi.g, ST_LineInterpolatePoint(w.wellstick_geom, 0.5))",
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
    box_sticks: bool = False  # preview: also return the record BOX stick set (geometry only)


def gunbarrel_sql(rule: Rule, econ_metric: str | None) -> str:
    econ_col = f", be.{ECON_METRICS[econ_metric]['col']} AS econ" if econ_metric else ""
    eur_cols = ", ".join(f"bs{s[0]}.eur_per_kft / 1000.0 AS {s}_eur_ft" for s in EUR_STREAMS)
    return f"""
            WITH aoi AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326) AS g)
            SELECT w.stick_id, w.unique_id, {kind_sql("w")} AS category, UPPER(w.formation) AS formation,
                   w.formation_blueox, w.basin_blueox, w.formation_blueox_source,
                   {map_coverage_sql("w")} AS coverage, {eur_cols},
                   bpp.outcome AS prox_outcome{econ_col},
                   w.tvd, w.ll_ft,
                   ST_X(ST_LineInterpolatePoint(w.wellstick_geom, 0.5)) AS mx,
                   ST_Y(ST_LineInterpolatePoint(w.wellstick_geom, 0.5)) AS my,
                   ST_X(ST_StartPoint(w.wellstick_geom)) AS sx, ST_Y(ST_StartPoint(w.wellstick_geom)) AS sy,
                   ST_X(ST_EndPoint(w.wellstick_geom))   AS ex, ST_Y(ST_EndPoint(w.wellstick_geom))   AS ey
            FROM curated.erebor_locations w
            CROSS JOIN aoi
            {box_joins("w", bench="w.formation_blueox")}
            {econ_join() if econ_metric else ""}
            WHERE w.basin = :basin AND w.wellstick_geom IS NOT NULL
              AND w.tvd IS NOT NULL AND {_PRED[rule]}
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
    box_rows = (session.execute(text(box_stick_gunbarrel_sql(body.rule)),
                                {"aoi": params["aoi"], "basin": body.basin}).mappings().all()
                if body.box_sticks else [])

    if not rows and not box_rows:
        return {"pad_count": 0, "pads": []}

    # One frame for the whole selection: shared centroid + a single offset axis
    # perpendicular to the mean heel->toe azimuth. The existing rows define it; BOX sticks
    # only do when the selection holds nothing else (their legs are then summed axially,
    # because the two legs of a U-turn stick run opposite ways).
    to_m, perp, axis_left, axis_right, cx, cy, mids = _frame(rows) if rows else _frame(box_rows, axial=True)

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
            "ll_ft": float(r["ll_ft"]) if r["ll_ft"] is not None else None,
            "offset_ft": round(offset_ft, 1),
        })
    wells.sort(key=lambda x: x["offset_ft"])
    pad = {
        "pad_name": "Selection", "well_count": len(wells),
        "axis_left": axis_left, "axis_right": axis_right,
        "wells": wells,
    }
    if body.box_sticks:
        pad["box_sticks"] = box_stick_points(box_rows, to_m, perp, cx, cy)
        pad["box_stick_count"] = len({b["stick_id"] for b in pad["box_sticks"]})
        pad["frame_from"] = "selection" if rows else "box_sticks"
    return {"pad_count": 1, "pads": [pad]}


def _frame(rows, axial: bool = False):  # noqa: ANN001, ANN202
    """The selection's frame from rows carrying sx/sy, ex/ey, mx/my (lon/lat): a local
    metre projection, the canonical offset axis, the centroid of the midpoints, and each
    row's midpoint in metres. `axial` sums the heel->toe vectors as undirected lines."""
    lat0 = sum(r["my"] for r in rows) / len(rows)
    lon0 = sum(r["mx"] for r in rows) / len(rows)
    k = math.cos(math.radians(lat0))

    def to_m(lon, lat):
        return ((lon - lon0) * M_PER_DEG_LON * k, (lat - lat0) * M_PER_DEG_LAT)

    dx = dy = 0.0
    mids = []
    ref = None
    for r in rows:
        sxm, sym = to_m(r["sx"], r["sy"])
        exm, eym = to_m(r["ex"], r["ey"])
        vx, vy = exm - sxm, eym - sym
        if axial:
            if ref is None:
                ref = (vx, vy)
            elif vx * ref[0] + vy * ref[1] < 0:
                vx, vy = -vx, -vy
        dx += vx
        dy += vy
        mids.append(to_m(r["mx"], r["my"]))
    norm = math.hypot(dx, dy)
    if norm < 1e-9:
        perp = (1.0, 0.0)
    else:
        ux, uy = dx / norm, dy / norm
        perp = (-uy, ux)  # rotate the mean lateral direction 90deg
    perp, axis_left, axis_right = _canonical_axis(perp)
    cx = sum(m[0] for m in mids) / len(mids)
    cy = sum(m[1] for m in mids) / len(mids)
    return to_m, perp, axis_left, axis_right, cx, cy, mids


def box_stick_points(box_rows, to_m, perp, cx, cy) -> list[dict]:  # noqa: ANN001
    """BOX stick legs as gunbarrel points in an existing frame: offset of the leg's midpoint,
    landing TVD, how the landing was derived and the nightly status. No forecast fields."""
    out = []
    for r in box_rows:
        mxm, mym = to_m(r["mx"], r["my"])
        out.append({
            "stick_id": r["stick_id"], "well_name": r["well_name"], "category": "BOX",
            "formation_blueox": r["formation_blueox"], "pad_id": r["pad_id"],
            "leg_no": r["leg_no"], "n_legs": r["n_legs"],
            "tvd": float(r["target_tvd_ft"]), "tvd_rung": r["tvd_rung"],
            "tvd_err_median_ft": float(r["tvd_err_median_ft"]) if r["tvd_err_median_ft"] is not None else None,
            "spacing_ft": float(r["spacing_ft"]),
            "ll_ft": float(r["ll_ft"]),
            "flags": list(r["flags"] or []),
            "status": r["status"],  # NULL = not judged by the nightly yet
            "crowded": bool(r["crowded"]) if r["crowded"] is not None else None,
            "matched_api10": r["matched_api10"],
            "offset_ft": round(((mxm - cx) * perp[0] + (mym - cy) * perp[1]) * FT_PER_M, 1),
        })
    out.sort(key=lambda b: (b["offset_ft"], b["tvd"], b["stick_id"], b["leg_no"]))
    return out
