"""In-process cache for the Map tab's vector tiles (api/tiles.py).

Why: a low-zoom tile carries every stick in it (z7 7/27/52 Delaware = 91k sticks,
6.4 MB) and costs ~4 s cold — ~2.6 s for PostGIS to build it plus the
Supabase -> backend transfer. Every zoom change at z <= 8 refetches the whole basin.
The tiles only change when the warehouse or the BOX record run / econ case does, so
the backend keeps the finished tiles and answers repeats in milliseconds.

  * Entries are GZIPPED MVT bytes (~28 % of raw at level 6) — served as-is with
    `Content-Encoding: gzip`, so memory and the wire both shrink.
  * Bounded LRU by bytes, with a TTL so the nightly erebor_locations refresh shows
    up within the hour. The caller puts the record run + econ case in the key, so a
    re-marked record run or a fresh econ push misses immediately (after the 60-s
    lookup cache in app.box_locations).
  * Single-flight per key: concurrent requests for the same tile (the browser and
    the prewarm, or two tabs) build it once; the others wait and take the result.

Pure Python, no DB — the tile SQL lives in api/tiles.py.
"""

from __future__ import annotations

import gzip
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable, Iterator


class TileCache:
    """Thread-safe LRU of gzipped tiles, bounded by total bytes, with a TTL."""

    def __init__(self, max_bytes: int, ttl_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.max_bytes = max_bytes
        self.ttl_s = ttl_s
        self._clock = clock
        self._entries: OrderedDict[Hashable, tuple[float, bytes]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self._building: dict[Hashable, threading.Lock] = {}
        self.hits = 0
        self.misses = 0

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def nbytes(self) -> int:
        return self._bytes

    def get(self, key: Hashable) -> bytes | None:
        """The gzipped tile, or None when absent or older than the TTL."""
        with self._lock:
            hit = self._entries.get(key)
            if hit is None:
                return None
            if self._clock() - hit[0] >= self.ttl_s:
                self._drop(key)
                return None
            self._entries.move_to_end(key)
            return hit[1]

    def put(self, key: Hashable, gz: bytes) -> None:
        with self._lock:
            if key in self._entries:
                self._drop(key)
            if len(gz) > self.max_bytes:
                return  # larger than the whole budget: serve it, don't keep it
            self._entries[key] = (self._clock(), gz)
            self._bytes += len(gz)
            while self._bytes > self.max_bytes:
                self._drop(next(iter(self._entries)))

    def get_or_build(self, key: Hashable, build: Callable[[], bytes]) -> tuple[bytes, bool]:
        """(gzipped tile, was_hit). `build` returns RAW MVT bytes (b"" = empty tile,
        cached too) and runs at most once per key at a time."""
        gz = self.get(key)
        if gz is not None:
            self.hits += 1
            return gz, True
        with self._lock:
            lk = self._building.setdefault(key, threading.Lock())
        with lk:
            gz = self.get(key)  # built by whoever held the lock first
            if gz is not None:
                self.hits += 1
                return gz, True
            self.misses += 1
            gz = gzip_tile(build())
            self.put(key, gz)
        with self._lock:
            if self._building.get(key) is lk:
                del self._building[key]
        return gz, False

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def _drop(self, key: Hashable) -> None:  # caller holds self._lock
        _, gz = self._entries.pop(key)
        self._bytes -= len(gz)


def gzip_tile(raw: bytes) -> bytes:
    """Level 6: 6.4 MB -> 1.8 MB in ~0.13 s. mtime=0 keeps the bytes deterministic.
    An empty tile stays b"" (the endpoint answers 204)."""
    return gzip.compress(raw, compresslevel=6, mtime=0) if raw else b""


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    """Web-Mercator XYZ tile holding (lon, lat) at zoom z (clamped to the grid)."""
    n = 1 << z
    lat = max(min(lat, 85.0511287798), -85.0511287798)
    x = int((lon + 180.0) / 360.0 * n)
    r = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tiles_covering(
    bbox: tuple[float, float, float, float], zooms: range
) -> Iterator[tuple[int, int, int]]:
    """Every (z, x, y) whose tile intersects bbox = (xmin, ymin, xmax, ymax) in lon/lat."""
    xmin, ymin, xmax, ymax = bbox
    for z in zooms:
        x0, y0 = lonlat_to_tile(xmin, ymax, z)  # north-west corner -> smallest y
        x1, y1 = lonlat_to_tile(xmax, ymin, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                yield z, x, y
