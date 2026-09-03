"""Gunbarrel axis canonicalization — the suite-wide reading convention.

``_canonical_axis`` is copy-shared across gunbarrel.py / highgrade.py /
accuracy.py (like the projection constants): a ~N-S lateral set's
cross-section reads W -> E, a ~E-W set's reads N -> S, regardless of the
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
def test_north_dominant_axis_reads_n_to_s(mod):
    # E-W laterals -> N-S cross-section. +offset must point SOUTH.
    axis, left, right = mod._canonical_axis((0.0, 1.0))
    assert axis == (0.0, -1.0) and (left, right) == ("N", "S")
    axis, left, right = mod._canonical_axis((0.0, -1.0))
    assert axis == (0.0, -1.0) and (left, right) == ("N", "S")


def test_copies_agree():
    # The three copy-shared implementations must behave identically
    # (cross-repo contract: change every copy or none).
    for deg in range(0, 360, 5):
        p = (math.cos(math.radians(deg)), math.sin(math.radians(deg)))
        results = {m._canonical_axis(p) for m in MODULES}
        assert len(results) == 1
