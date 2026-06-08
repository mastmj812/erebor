"""Shared decline-curve evaluation + EUR integration.

Pure numpy/scipy; no app dependencies. Consumed by erebor (and, once a
Docker-compatible packaging path exists, by permian_type_curve via re-export
shims). Convention: time in years, Di nominal per-year, rates per-day.
"""

from decline.constants import (
    DEFAULT_DF_TERMINAL_PER_YEAR,
    DEFAULT_FORECAST_HORIZON_YEARS,
)
from decline.eur import DAYS_PER_YEAR, compute_eur
from decline.models import (
    arps_exponential,
    arps_harmonic,
    arps_hyperbolic,
    duong,
    modified_hyperbolic,
    switchover_time,
)

__all__ = [
    "arps_exponential",
    "arps_hyperbolic",
    "arps_harmonic",
    "modified_hyperbolic",
    "switchover_time",
    "duong",
    "compute_eur",
    "DAYS_PER_YEAR",
    "DEFAULT_DF_TERMINAL_PER_YEAR",
    "DEFAULT_FORECAST_HORIZON_YEARS",
]
