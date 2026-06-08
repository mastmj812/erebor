"""Known-value tests for the shared decline package.

Hand-derived values pin the math so a future edit can't silently change it.
Mirrors the spirit of permian_type_curve's test_decline_models / test_eur.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from decline.eur import DAYS_PER_YEAR, _solve_t_at_rate, compute_eur
from decline.models import (
    arps_exponential,
    arps_harmonic,
    arps_hyperbolic,
    duong,
    modified_hyperbolic,
    switchover_time,
)


def test_exponential_rate() -> None:
    assert arps_exponential(1.0, 1000.0, 0.5) == pytest.approx(1000.0 * math.exp(-0.5))
    # vectorized
    out = arps_exponential(np.array([0.0, 1.0]), 1000.0, 0.5)
    assert out[0] == pytest.approx(1000.0)


def test_hyperbolic_equals_harmonic_at_b1() -> None:
    t = np.linspace(0, 10, 50)
    hyp = arps_hyperbolic(t, 1000.0, 0.7, 1.0)
    har = arps_harmonic(t, 1000.0, 0.7)
    assert np.allclose(hyp, har)


def test_hyperbolic_known_value() -> None:
    # q(1) = qi / (1 + b*Di*1)**(1/b), b=0.5, Di=0.8 -> 1000 / (1+0.4)**2
    assert arps_hyperbolic(1.0, 1000.0, 0.8, 0.5) == pytest.approx(1000.0 / (1.4**2))


def test_hyperbolic_degenerates_to_exponential_at_tiny_b() -> None:
    assert arps_hyperbolic(2.0, 500.0, 0.6, 1e-9) == pytest.approx(
        arps_exponential(2.0, 500.0, 0.6)
    )


def test_switchover_time_closed_form() -> None:
    # t_s = (Di/Df - 1)/(b*Di); Di=1.0, Df=0.08, b=1.0 -> (12.5-1)/1 = 11.5
    assert switchover_time(1.0, 0.08, 1.0) == pytest.approx(11.5)
    assert switchover_time(0.5, 0.0, 1.0) == float("inf")  # Df<=0 -> no switchover


def test_modified_hyperbolic_continuous_at_switchover() -> None:
    qi, Di, b, Df = 1200.0, 1.0, 1.1, 0.08
    t_s = switchover_time(Di, Df, b)
    left = modified_hyperbolic(t_s - 1e-6, qi, Di, b, Df)
    right = modified_hyperbolic(t_s + 1e-6, qi, Di, b, Df)
    assert left == pytest.approx(right, rel=1e-4)


def test_exponential_eur_closed_form() -> None:
    # asymptotic EUR = qi/Di * 365; with horizon 50 it's nearly asymptotic
    eur = compute_eur("arps_exponential", {"qi": 500.0, "Di": 0.85}, horizon_years=50.0)
    assert eur == pytest.approx(500.0 / 0.85 * DAYS_PER_YEAR, rel=1e-6)


def test_hyperbolic_eur_converges_with_econ_limit() -> None:
    # b>=1 diverges over 50yr without an economic limit; with one it's finite.
    eur = compute_eur(
        "arps_hyperbolic", {"qi": 1000.0, "Di": 0.7, "b": 1.1},
        horizon_years=50.0, economic_limit=10.0,
    )
    assert math.isfinite(eur) and eur > 0


def test_solve_t_at_rate_inverts_rate() -> None:
    params = {"qi": 1000.0, "Di": 0.7, "b": 1.1}
    t = _solve_t_at_rate(50.0, "arps_hyperbolic", params)
    assert arps_hyperbolic(t, **params) == pytest.approx(50.0, rel=1e-6)


def test_duong_at_t1_equals_q1() -> None:
    # at t=1: t**(-m)=1 and exp(a/(1-m)*(1-1))=exp(0)=1 -> q(1)=q1
    assert duong(1.0, 800.0, 1.2, 0.05) == pytest.approx(800.0)
