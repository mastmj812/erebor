"""Map tile speed-ups (app.tile_cache + api/tiles.py), DB-free.

Pins: the cache is a byte-bounded LRU with a TTL; concurrent requests for one tile
build it once; an empty tile is cached and answered 204; the cache key carries the
record run and the econ case (so a re-marked run or a fresh econ push misses); the
binary fetch runs the same SQL with driver placeholders; gzip is served only to a
client that asks for it, and the bytes it decodes to are the tile unchanged.
"""

import datetime as dt
import gzip
import re
import threading
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy.dialects.postgresql import psycopg as pg_psycopg

from app.api import tiles
from app.db import get_session
from app.main import app
from app.tile_cache import TileCache, gzip_tile, lonlat_to_tile, tiles_covering


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def test_lru_evicts_oldest_by_bytes_and_get_refreshes_recency():
    c = TileCache(max_bytes=10, ttl_s=100)
    c.put("a", b"xxxx")
    c.put("b", b"yyyy")
    assert c.get("a") == b"xxxx"         # touch a -> b is now the oldest
    c.put("c", b"zzzz")                  # 12 bytes > 10 -> evict b
    assert c.get("b") is None and c.get("a") == b"xxxx" and c.get("c") == b"zzzz"
    assert c.nbytes == 8 and len(c) == 2
    c.put("huge", b"0" * 11)             # bigger than the whole budget: not kept
    assert c.get("huge") is None and c.nbytes == 8


def test_ttl_expires_entries():
    clock = _Clock()
    c = TileCache(max_bytes=100, ttl_s=60, clock=clock)
    c.put("k", b"v")
    clock.t = 59.9
    assert c.get("k") == b"v"
    clock.t = 60.0
    assert c.get("k") is None and c.nbytes == 0


def test_get_or_build_gzips_caches_and_counts():
    c = TileCache(max_bytes=1 << 20, ttl_s=60)
    raw = b"\x1a\x05tile!" * 100
    gz, hit = c.get_or_build("k", lambda: raw)
    assert not hit and gzip.decompress(gz) == raw and len(gz) < len(raw)
    gz2, hit2 = c.get_or_build("k", lambda: b"never called")
    assert hit2 and gz2 == gz and (c.hits, c.misses) == (1, 1)
    # an empty tile is cached as b"" (-> 204), not rebuilt every time
    assert c.get_or_build("empty", lambda: b"") == (b"", False)
    assert c.get_or_build("empty", lambda: b"x") == (b"", True)


def test_concurrent_requests_build_a_tile_once():
    c = TileCache(max_bytes=1 << 20, ttl_s=60)
    calls = []

    def build() -> bytes:
        calls.append(1)
        time.sleep(0.05)
        return b"tile"

    results = []
    threads = [threading.Thread(target=lambda: results.append(c.get_or_build("k", build))) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1 and len(results) == 8
    assert all(gzip.decompress(gz) == b"tile" for gz, _ in results)
    assert sum(1 for _, hit in results if not hit) == 1


def test_gzip_is_deterministic():
    assert gzip_tile(b"abc" * 50) == gzip_tile(b"abc" * 50) and gzip_tile(b"") == b""


def test_tile_math_matches_the_measured_delaware_tiles():
    # the densest z7 Delaware tile measured 2026-10-21 (91k sticks)
    assert lonlat_to_tile(-103.5, 31.5, 7) == (27, 52)
    assert lonlat_to_tile(-180.0, 85.06, 0) == (0, 0) and lonlat_to_tile(180.0, -85.06, 2) == (3, 3)
    got = set(tiles_covering((-104.9, 30.6, -103.0, 32.9), range(7, 8)))
    assert got == {(7, 26, 51), (7, 26, 52), (7, 27, 51), (7, 27, 52)}


def test_prewarm_order_starts_at_the_requested_zoom_and_covers_z3_to_z8():
    order = tiles.prewarm_order((-104.9, 30.6, -103.0, 32.9), 7)
    assert {z for z, _, _ in order[:4]} == {7} and order[4][0] == 8   # then zoom in before out
    assert {z for z, _, _ in order} == set(range(3, 9))
    zs = [abs(z - 7) for z, _, _ in order]
    assert zs == sorted(zs)


def test_cache_key_carries_record_run_and_econ_case():
    case = {"deck_id": "wti70_hh3", "assumption_set_id": "a", "built_at": dt.datetime(2026, 10, 20)}
    base = tiles._tile_key("delaware", 7, 27, 52, 14, (), None)
    assert base == tiles._tile_key("delaware", 7, 27, 52, 14, (), case)          # no econ: case irrelevant
    assert base != tiles._tile_key("delaware", 7, 27, 52, 15, (), None)          # re-marked record run
    priced = tiles._tile_key("delaware", 7, 27, 52, 14, ("pv10",), case)
    assert priced != base and priced != tiles._tile_key("delaware", 7, 27, 52, 14, ("irr",), case)
    assert priced != tiles._tile_key("delaware", 7, 27, 52, 14, ("irr", "pv10"), case)  # metric SET
    pushed = {**case, "built_at": dt.datetime(2026, 10, 21)}
    assert priced != tiles._tile_key("delaware", 7, 27, 52, 14, ("pv10",), pushed)  # fresh econ push


def test_econ_metric_set_is_order_free_and_whitelisted():
    assert tiles.econ_metric_set("pv10,irr,pv10") == ("irr", "pv10") == tiles.econ_metric_set("irr,pv10")
    assert tiles.econ_metric_set(None) == () == tiles.econ_metric_set("")
    pat = re.compile(tiles._ECON_PATTERN)
    assert pat.match("pv10") and pat.match("pv10,irr,be_wti")
    assert not pat.match("pv10,") and not pat.match("pv10;drop") and not pat.match("pv10_mm")


def test_binary_fetch_sql_uses_driver_placeholders_and_keeps_casts():
    session = SimpleNamespace(get_bind=lambda: SimpleNamespace(dialect=pg_psycopg.dialect()))
    for kind, econ in (("points", ()), ("lines", ("pv10",)), ("lines", ("irr", "pv10"))):
        params = tiles._params(7, 27, 52, "delaware", 14,
                               {"deck_id": "wti70_hh3", "assumption_set_id": "a"} if econ else None)
        stmt, args = tiles._driver_sql(session, tiles._mvt_sql(kind, econ), params)
        assert not re.search(r"(?<!:):[a-z_]+\b", stmt)                 # no SQLAlchemy binds left
        assert set(re.findall(r"%\((\w+)\)s", stmt)) <= set(args) and args["box_run"] == 14
        assert "::numeric" in stmt and "::float8" in stmt
        assert ("box_econ.box_pud_econ" in stmt) == bool(econ)
        assert all(f"AS econ_{m}" in stmt for m in econ)


def test_endpoint_serves_gzip_from_cache(monkeypatch):
    raw = b"\x1a\x0fmvt-bytes" * 64
    calls = []
    monkeypatch.setattr(tiles, "_cache", TileCache(1 << 20, 60))
    monkeypatch.setattr(tiles, "record_run_id", lambda s: 14)
    monkeypatch.setattr(tiles, "_fetch_tile", lambda s, sql, p: calls.append(p) or (raw if p["x"] == 27 else b""))
    monkeypatch.setattr(tiles.settings, "tile_prewarm", False)
    app.dependency_overrides[get_session] = lambda: None
    try:
        client = TestClient(app)
        r1 = client.get("/api/tiles/7/27/52.mvt?basin=delaware", headers={"Accept-Encoding": "gzip"})
        assert r1.status_code == 200 and r1.headers["x-tile-cache"] == "miss"
        assert r1.headers["content-encoding"] == "gzip" and r1.content == raw   # httpx decodes it
        r2 = client.get("/api/tiles/7/27/52.mvt?basin=delaware", headers={"Accept-Encoding": "identity"})
        assert r2.headers["x-tile-cache"] == "hit" and "content-encoding" not in r2.headers
        # newer Starlette's CORS middleware appends ", Origin" to Vary — only ours is pinned
        vary = [v.strip() for v in r2.headers["vary"].split(",")]
        assert r2.content == raw and "Accept-Encoding" in vary
        assert len(calls) == 1 and calls[0]["box_run"] == 14 and calls[0]["econ_deck"] is None
        r3 = client.get("/api/tiles/7/26/52.mvt?basin=delaware")
        assert r3.status_code == 204 and r3.content == b""
        assert client.get("/api/tiles/7/26/52.mvt?basin=delaware").headers["x-tile-cache"] == "hit"
    finally:
        app.dependency_overrides.pop(get_session, None)
