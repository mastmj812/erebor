"""Shared tuning constants for decline evaluation + EUR.

Mirrors the relevant defaults from permian_type_curve's forecasting.types.
Kept as a small standalone module so the shared package carries no dependency
on either app's config.
"""

from __future__ import annotations

# Modified-hyperbolic terminal decline default (8%/yr).
DEFAULT_DF_TERMINAL_PER_YEAR: float = 0.08
# Forecast horizon cap (years). Novi Intelligence Arps tails run to 50 yr.
DEFAULT_FORECAST_HORIZON_YEARS: float = 50.0
# Default economic limit is 0 — EUR is the raw horizon integral. A positive
# value truncates at the rate floor for callers that need that semantic.
DEFAULT_ECONOMIC_LIMIT_BOPD: float = 0.0
DEFAULT_ECONOMIC_LIMIT_MCFD: float = 0.0
DEFAULT_ECONOMIC_LIMIT_BWPD: float = 0.0
