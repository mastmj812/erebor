"""Vector tiles for the erebor map, rendered server-side by PostGIS from
curated.erebor_locations (PUD/RES = the Novi location universe; PDP = curated
producing horizontals — see sql/22 in engineering_db) with the BOX record run's
per-location projection joined on (app.box_locations — the one module that reads
BOX attributes).

  * z <= 8  -> intel_points  (lateral heel point, cheap at low zoom)
  * z >= 9  -> intel_lines   (full wellstick LINESTRING)

basin is required (the map shows one basin at a time). Every category ships in
every tile; the frontend filters client-side (no refetch). Novi supplies only the
stick geometry: `category` is PDP | LOCATION (Novi's PUD / RES tag is not shipped).
BOX properties per stick: `coverage` (NULL on PDP — producing context, never
forecast; app.box_locations.map_coverage_sql), `water_tier`, `oil_eur_ft` / `gas_eur_ft` / `water_eur_ft` (per FOOT),
`prox_outcome`, `prox_factor` (only when < 1). A not-covered stick has no EUR
property at all (MVT omits NULLs) — never a zero.

`econ` (optional, `?econ=<metric>[,<metric>...]&deck=<deck_id>`): the whitelisted
columns of Steven's the map needs (the color metric + any econ range), one property
`econ_<metric>` each, for the RECORD run's priced case (display-only, D13). An
unpriced run leaves them off every stick; the econ legend says "not yet priced".

Speed (low zoom carries the whole basin: z7 7/27/52 Delaware = 91k sticks, 6.4 MB):
  * the tile bytea is fetched in psycopg's BINARY result format — the default text
    format ships it hex-encoded, twice the bytes over the Supabase link;
  * finished tiles live in app.tile_cache (gzipped, served with Content-Encoding:
    gzip), keyed on the URL + record run + econ case, so repeats cost milliseconds;
  * the first z <= 8 tile of a basin (non-econ URL) starts a background prewarm of
    that basin's z3-8 tiles, nearest zoom first, so zooming around low zoom is warm.
None of the three changes the tile bytes.
"""

from __future__ import annotations

import gzip
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.box_locations import ECON_METRICS, box_joins, econ_case, econ_join, record_run_id, tile_columns
from app.config import settings
from app.db import SessionLocal, get_session
from app.tile_cache import TileCache, tiles_covering

log = logging.getLogger(__name__)

router = APIRouter(prefix="/tiles", tags=["tiles"])

POINTS_MAX_Z = 8
# The intel source's minzoom (MapView.tsx) — the prewarm builds z3..POINTS_MAX_Z.
PREWARM_ZOOMS = range(3, POINTS_MAX_Z + 1)
PREWARM_WORKERS = 2
MVT_CONTENT_TYPE = "application/vnd.mapbox-vector-tile"

_GEOM = {"points": "ST_StartPoint(w.wellstick_geom)", "lines": "w.wellstick_geom"}
_ECON_ONE = "(" + "|".join(ECON_METRICS) + ")"
_ECON_PATTERN = f"^{_ECON_ONE}(,{_ECON_ONE})*$"


def econ_metric_set(econ: str | None) -> tuple[str, ...]:
    """`?econ=irr,pv10,irr` -> ('irr', 'pv10'): de-duplicated and sorted, so the tile SQL
    and the cache key do not depend on the order the client listed them in."""
    return tuple(sorted({m for m in (econ or "").split(",") if m}))


def _mvt_sql(kind: str, econ_metrics: tuple[str, ...]) -> str:
    layer = "intel_points" if kind == "points" else "intel_lines"
    geom_expr = _GEOM[kind]
    return f"""
WITH bounds AS (SELECT ST_TileEnvelope(:z, :x, :y) AS env)
, mvtgeom AS (
  SELECT
    w.stick_id,
    w.unique_id,
    -- PDP vs a Novi stick location; Novi's own PUD / RES tag is not shipped (only the
    -- stick geometry comes from Novi — classification is BOX's `coverage`).
    CASE WHEN w.category = 'PDP' THEN 'PDP' ELSE 'LOCATION' END AS category,
    w.formation_blueox,
    w.basin_blueox,
    w.operator,
    w.ll_ft,
    {tile_columns("w", econ_metrics)},
    ST_AsMVTGeom(
      ST_Transform({geom_expr}, 3857),
      (SELECT env FROM bounds), 4096, 64, true
    ) AS geom
  FROM curated.erebor_locations w
  {box_joins("w", bench="w.formation_blueox")}
  {econ_join() if econ_metrics else ""}
  WHERE w.basin = :basin
    AND w.wellstick_geom IS NOT NULL
    -- Intersect in the geometry's native SRID (4326) so the GiST index on
    -- wellstick_geom is usable. Transforming the *column* to 3857 (as
    -- ST_AsMVTGeom does for output) would force a per-row transform + seq scan;
    -- transforming the tile envelope back to 4326 keeps the index in play.
    AND ST_Intersects(w.wellstick_geom, ST_Transform((SELECT env FROM bounds), 4326))
)
SELECT ST_AsMVT(mvtgeom.*, '{layer}', 4096, 'geom')
FROM mvtgeom WHERE geom IS NOT NULL
"""


@router.get("/{z}/{x}/{y}.mvt")
def tile(
    request: Request,
    z: int = Path(ge=0, le=22),
    x: int = Path(ge=0),
    y: int = Path(ge=0),
    basin: str = Query(..., pattern="^(delaware|midland)$"),
    econ: str | None = Query(None, pattern=_ECON_PATTERN),
    deck: str | None = Query(None, max_length=64),
    session: Session = Depends(get_session),
) -> Response:
    if x >= (1 << z) or y >= (1 << z):
        raise HTTPException(status_code=400, detail="tile coords out of range for z")
    kind = "points" if z <= POINTS_MAX_Z else "lines"
    run_id = record_run_id(session)
    wanted = econ_metric_set(econ)
    case = econ_case(session, run_id, deck) if (wanted and run_id is not None) else None
    econ_metrics = wanted if case is not None else ()
    params = _params(z, x, y, basin, run_id, case)
    gz, hit = _cache.get_or_build(
        _tile_key(basin, z, x, y, run_id, econ_metrics, case),
        lambda: _fetch_tile(session, _mvt_sql(kind, econ_metrics), params),
    )
    if kind == "points" and not econ_metrics and settings.tile_prewarm:
        _start_prewarm(basin, run_id, z)
    headers = {"Cache-Control": "public, max-age=60", "Vary": "Accept-Encoding",
               "X-Tile-Cache": "hit" if hit else "miss"}
    if not gz:
        return Response(status_code=204, headers=headers)
    if "gzip" in request.headers.get("accept-encoding", "").lower():
        headers["Content-Encoding"] = "gzip"
        return Response(content=gz, media_type=MVT_CONTENT_TYPE, headers=headers)
    return Response(content=gzip.decompress(gz), media_type=MVT_CONTENT_TYPE, headers=headers)


# --- tile bytes, cache key, prewarm -------------------------------------------------
_cache = TileCache(settings.tile_cache_mb << 20, settings.tile_cache_ttl_s)


def _params(z: int, x: int, y: int, basin: str, run_id: int | None,
            case: dict[str, Any] | None) -> dict[str, Any]:
    return {"z": z, "x": x, "y": y, "basin": basin, "box_run": run_id,
            "econ_deck": case["deck_id"] if case else None,
            "econ_aset": case["assumption_set_id"] if case else None}


def _tile_key(basin: str, z: int, x: int, y: int, run_id: int | None,
              econ_metrics: tuple[str, ...], case: dict[str, Any] | None) -> tuple:
    """Everything a tile's bytes depend on besides the warehouse rows themselves (those
    age out by TTL): the record run, and for an econ tile the metric set + the priced
    case incl. its build time, so a fresh econ push or a re-marked record run misses."""
    econ_part = None
    if econ_metrics and case is not None:
        econ_part = (econ_metrics, case["deck_id"], case["assumption_set_id"], str(case.get("built_at")))
    return (basin, z, x, y, run_id, econ_part)


def _driver_sql(session: Session, sql: str, params: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """The text() SQL compiled for the session's driver: psycopg pyformat placeholders,
    with the `::` casts and any literal % handled by SQLAlchemy. Like session.execute,
    params the SQL doesn't use are ignored (the econ binds on a plain tile)."""
    compiled = text(sql).compile(dialect=session.get_bind().dialect)
    return compiled.string, {k: params[k] for k in compiled.params}


def _fetch_tile(session: Session, sql: str, params: dict[str, Any]) -> bytes:
    """Run the tile SQL; return the raw MVT bytes (b"" = empty tile). Fetched in the
    BINARY result format: the default text format ships bytea hex-encoded — twice the
    bytes over the Supabase link (z7 7/27/52: 5.3 s -> 4.25 s, byte-identical tile).
    Runs on the session's own connection, inside the transaction the app.db begin hook
    made READ ONLY with its statement_timeout."""
    stmt, args = _driver_sql(session, sql, params)
    dbapi = session.connection().connection.dbapi_connection
    with dbapi.cursor(binary=True) as cur:
        cur.execute(stmt, args)
        row = cur.fetchone()
    return bytes(row[0]) if row is not None and row[0] is not None else b""


_BBOX_SQL = """
SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e)
FROM (SELECT ST_Extent(wellstick_geom) AS e FROM curated.erebor_locations
      WHERE basin = :basin AND wellstick_geom IS NOT NULL) q
"""
_prewarm_started: dict[tuple[str, int | None], float] = {}
_prewarm_lock = threading.Lock()


def _start_prewarm(basin: str, run_id: int | None, z_req: int) -> None:
    """Start the basin's low-zoom prewarm once per (basin, record run) per cache TTL."""
    key = (basin, run_id)
    now = time.monotonic()
    with _prewarm_lock:
        started = _prewarm_started.get(key)
        if started is not None and now - started < _cache.ttl_s:
            return
        _prewarm_started[key] = now
    threading.Thread(target=_prewarm, args=(basin, run_id, z_req),
                     name=f"tile-prewarm-{basin}", daemon=True).start()


def prewarm_order(bbox: tuple[float, float, float, float], z_req: int) -> list[tuple[int, int, int]]:
    """The basin's z3-8 tiles: the requested zoom first, then outward, zooming in before
    zooming out at each step (scouting zooms in; z+1 also has more, smaller tiles)."""
    return sorted(tiles_covering(bbox, PREWARM_ZOOMS),
                  key=lambda t: (abs(t[0] - z_req), t[0] < z_req, t))


def _prewarm(basin: str, run_id: int | None, z_req: int) -> None:
    t0 = time.perf_counter()
    try:
        with SessionLocal() as s:
            bbox = s.execute(text(_BBOX_SQL), {"basin": basin}).one()
        if bbox[0] is None:
            return
        todo = prewarm_order((bbox[0], bbox[1], bbox[2], bbox[3]), z_req)
        built: list[int] = []  # list.append is atomic across the workers

        def one(t: tuple[int, int, int]) -> None:
            z, x, y = t
            key = _tile_key(basin, z, x, y, run_id, (), None)
            if _cache.get(key) is not None:
                return
            with SessionLocal() as s:
                _, hit = _cache.get_or_build(
                    key, lambda: _fetch_tile(s, _mvt_sql("points", ()), _params(z, x, y, basin, run_id, None)))
            if not hit:
                built.append(1)

        with ThreadPoolExecutor(PREWARM_WORKERS, thread_name_prefix=f"tile-prewarm-{basin}") as ex:
            list(ex.map(one, todo))
        log.info("tile prewarm %s run %s: %d tiles (%d built) in %.1f s; cache %d tiles / %.1f MB gz",
                 basin, run_id, len(todo), len(built), time.perf_counter() - t0, len(_cache), _cache.nbytes / 1e6)
    except Exception:
        log.exception("tile prewarm failed for %s (retried on the next low-zoom tile)", basin)
        with _prewarm_lock:
            _prewarm_started.pop((basin, run_id), None)
