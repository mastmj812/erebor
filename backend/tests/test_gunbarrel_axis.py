"""Gunbarrel axis canonicalization — the suite-wide reading convention.

``_canonical_axis`` is copy-shared across gunbarrel.py / highgrade.py /
accuracy.py (like the projection constants): a ~N-S lateral set's
cross-section reads W -> E, a ~E-W set's reads S -> N (sign rule v2), regardless of the
data-order-arbitrary sign of the mean heel->toe perpendicular.
"""

import math

import pytest

from app.api import accuracy, gunbarrel, highgrade

MODULES = (gunbarrel, highgrade, accuracy)


@pytest.mark.parametrize("mod", MODULES, ids=lambda m: m.__name__)
def test_east_dominant_axis_reads_w_to_e(mod):
    # N-S laterals -> E-W cross-section. +offset must point EAST whichever
    # way the raw perpendicular came out of the mean heel->toe rotation.
    axis, left, right = mod._canonical_axis((1.0, 0.0))
    assert axis == (1.0, 0.0) and (left, right) == ("W", "E")
    axis, left, right = mod._canonical_axis((-1.0, 0.0))
    assert axis == (1.0, 0.0) and (left, right) == ("W", "E")
    # Oblique but east-dominant (folded azimuth ~170 deg -> perp west-ish).
    axis, left, right = mod._canonical_axis((-0.985, -0.174))
    assert axis[0] > 0 and (left, right) == ("W", "E")


@pytest.mark.parametrize("mod", MODULES, ids=lambda m: m.__name__)
def test_north_dominant_axis_reads_s_to_n(mod):
    # E-W laterals -> N-S cross-section. +offset must point NORTH (rule v2).
    axis, left, right = mod._canonical_axis((0.0, 1.0))
    assert axis == (0.0, 1.0) and (left, right) == ("S", "N")
    axis, left, right = mod._canonical_axis((0.0, -1.0))
    assert axis == (0.0, 1.0) and (left, right) == ("S", "N")


def test_copies_agree():
    # The three copy-shared implementations must behave identically
    # (cross-repo contract: change every copy or none).
    for deg in range(0, 360, 5):
        p = (math.cos(math.radians(deg)), math.sin(math.radians(deg)))
        results = {m._canonical_axis(p) for m in MODULES}
        assert len(results) == 1


# THE golden table (lateral azimuth -> compass bearing of +offset), gunbarrel
# sign rule v2 — byte-identical to narvi tests/test_gunbarrel_convention.py,
# anduin test_blueox_export.py and engineering_db test_dealintake_core.py.
GOLDEN_PLUS_BEARING = [
    (0.0, 90.0), (0.3, 90.3), (40.2, 130.2), (45.0, 135.0), (45.04, 135.04),
    (45.06, 315.06), (45.1, 315.1), (55.3, 325.3), (71.3, 341.3), (89.0, 359.0),
    (90.0, 0.0), (128.8, 38.8), (161.3, 71.3), (179.5, 89.5), (179.96, 89.96),
    (180.0, 90.0), (200.0, 110.0), (-18.7, 71.3),
]


@pytest.mark.parametrize("mod", MODULES, ids=lambda m: m.__name__)
def test_golden_plus_bearing(mod):
    # erebor canonicalizes a computed perpendicular (display-only, never
    # persisted), so it has no 0.1-deg header rounding: the two table rows
    # inside the rounding band of the 45-deg seam (45.04) are narvi/anduin-only.
    for az, want in GOLDEN_PLUS_BEARING:
        if 45.0 < az % 180.0 < 45.05:
            continue
        a = math.radians(az)
        for sgn in (1.0, -1.0):        # data-order arbitrary perpendicular
            (px, py), _, _ = mod._canonical_axis((sgn * math.cos(a), -sgn * math.sin(a)))
            got = math.degrees(math.atan2(px, py)) % 360.0
            assert abs((got - want + 180.0) % 360.0 - 180.0) < 1e-6, (az, got, want)
