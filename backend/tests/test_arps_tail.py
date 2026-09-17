"""Regression: Novi terminal exponential segments ship d_nom = NULL.

Every terminal segment in the share (both basins, both vintages) carries
d_nom NULL — the decline hides in d_eff_tangent in PER-DAY units, unlike
segments 1-2 where that column is per-year. The pre-2026-09-17 coalesce
NULL->0 made the 50-yr tail run FLAT at the terminal q_start from ~month
360, inflating long-horizon cums in the aggregate panel and the xlsx
export vectors (caught visually by Michael on a toucan dossier panel).
The money-test fixtures never caught it because they populate d_nom.
"""

from __future__ import annotations

import numpy as np
from pytest import approx

from app.api.production import _seg_decline_per_year, _tail_values

# Real segment shape from curated.intel_arps ('2 Mile A 100 BRN 1', oil):
_TERMINAL = {
    "segment_curve_type": "exponential",
    "b": 0.0,
    "d_nom": None,
    "q_start": 16.3502883911133,
    "q_stop": 2.2589738368988,
    "day_start": 6573,
    "day_stop": 18250,
}


def test_null_dnom_derives_endpoint_decline() -> None:
    d = _seg_decline_per_year(_TERMINAL)
    # ln(16.35/2.259) * 365 / (18250-6573) = 0.0619/yr — matches the
    # share's per-day d_eff_tangent (0.0001695 * 365).
    assert d == approx(0.0619, rel=0.01)


def test_null_dnom_tail_declines_not_flat() -> None:
    arr = np.asarray([6573.0, 10800.0, 18250.0], dtype=float)
    vals = _tail_values([_TERMINAL], arr)
    assert vals[0] == approx(_TERMINAL["q_start"], rel=1e-6)  # continuous at seam
    assert vals[1] == approx(8.0, rel=0.05)  # mid-tail, was 16.35 flat pre-fix
    assert vals[2] == approx(_TERMINAL["q_stop"], rel=0.01)  # lands on q_stop


def test_anchored_tail_continues_forecast_level() -> None:
    # Novi's monthly rows run ~13-15% below their own Arps curve in the
    # terminal region (calendar-day factor on the series, ideal rates in
    # the params) — the tail must take the segments' SHAPE at the
    # forecast's LEVEL, or the stitch steps up at the seam.
    from app.api.production import _anchored_tail

    last_day = 10770.0
    last_rate = 6.96  # forecast's final row, ~0.87x the Arps evaluation
    arr = np.asarray([10800.0, 14000.0], dtype=float)
    raw = _tail_values([_TERMINAL], arr)
    anchored = _anchored_tail([_TERMINAL], arr, last_day, last_rate)
    seam = _tail_values([_TERMINAL], np.asarray([last_day]))[0]
    k = last_rate / seam
    assert anchored[0] == approx(raw[0] * k, rel=1e-9)
    assert anchored[0] == approx(last_rate, rel=0.01)  # continuous at seam
    assert anchored[1] < anchored[0]  # still declining

    # no forecast level -> raw tail unchanged
    assert _anchored_tail([_TERMINAL], arr, last_day, 0.0)[0] == approx(raw[0])


def test_populated_dnom_unchanged() -> None:
    seg = dict(_TERMINAL, d_nom=0.4)
    assert _seg_decline_per_year(seg) == 0.4


def test_unusable_endpoints_stay_zero() -> None:
    seg = dict(_TERMINAL, d_nom=None, q_stop=0.0)
    assert _seg_decline_per_year(seg) == 0.0
