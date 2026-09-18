// Accuracy tab API — Novi Intelligence forecast vs realized actuals.
// Backed by curated.intel_forecast_accuracy (engineering_db sql/38) via
// backend/app/api/accuracy.py.

export type AccTier = "all" | "direct" | "proxy";

// Vintage mode (2026-09-18): every endpoint takes an optional report_version
// ("2025Q3") that swaps the source to the per-retained-vintage matview
// (sql/43, direct tier only — superseded vintages stay reviewable). null =
// the live vintage (sql/38).
export type AccVintage = string | null;

export interface AccVintages {
  live: { label: string; n_wells: number };
  vintages: { report_version: string; n_direct_wells: number }[];
}

export async function fetchAccVintages(): Promise<AccVintages> {
  const r = await fetch("/api/accuracy/vintages");
  if (!r.ok) throw new Error(`accuracy vintages failed: ${r.status}`);
  return r.json();
}
export type AccNorm = "perft" | "raw";
export type AccHorizon = 3 | 6 | 9 | 12;
export const ACC_HORIZONS: AccHorizon[] = [3, 6, 9, 12];

// Feature properties on /accuracy/wells. Error keys are err{h}_{stream} (raw,
// direct tier only) and err{h}_{stream}_perft (both tiers), h in 3/6/9/12 —
// null when history is short, the horizon month is the latest reported, or no
// benchmark exists (rendered grey).
export interface AccWellProps {
  api10: string;
  // "unmatched" only in vintage mode (no qualifying stick; errors all null)
  tier: "direct" | "proxy" | "unmatched";
  operator: string | null;
  formation_blueox: string;
  pad_name: string | null;
  first_prod: string;
  n_months: number;
  ll_ratio: number | null;
  n_rep: number;
  low_n: boolean;
  n_sticks_for_well: number | null;
  [err: string]: unknown; // err3_oil_perft, err6_gas, ...
}

export interface AccWellsResponse {
  basin: string;
  well_count: number;
  wells: GeoJSON.FeatureCollection;
}

export interface AccSlice {
  n: number;
  bias_pct: number | null;
  mae_pct: number | null;
}
export interface AccSummary {
  basin: string;
  vintage?: string | null;
  tier: AccTier;
  stream: string;
  norm: AccNorm;
  horizon: number;
  headline: AccSlice & { mop: number; median_pct: number | null };
  by_month: (AccSlice & { mop: number })[];
  by_tier: (AccSlice & { tier: string })[];
  by_bench: (AccSlice & { formation_blueox: string })[];
  by_operator: (AccSlice & { operator: string })[];
  ll_ratio: { mean: number | null; p10: number | null; p90: number | null };
  histogram: { bin_edges: number[]; counts: number[] };
}

export interface AccStreamSeries {
  fcst_cum: (number | null)[];
  actual_cum: (number | null)[];
  fcst_cum_perft: (number | null)[];
  actual_cum_perft: (number | null)[];
  pct_err: (number | null)[];
  pct_err_perft: (number | null)[];
}
export interface AccGunbarrelWell {
  role: "subject" | "comparison" | "context";
  kind: "pdp" | "stick";
  api10: string | null;
  stick_id: number | null;
  category: string;
  formation_blueox: string | null;
  operator: string | null;
  tvd: number;
  ll_ft: number | null;
  offset_ft: number;
}
export interface AccWellDetail {
  api10: string;
  tier: "direct" | "proxy" | "unmatched";
  basin: string;
  vintage?: string | null;
  formation_blueox: string | null;
  operator: string | null;
  pad_name: string | null;
  first_prod: string;
  drilled_ll_ft: number | null;
  novi_ll_ft: number | null;
  rep_median_ll_ft: number | null;
  ll_ratio: number | null;
  match_overlap: number | null;
  n_sticks_for_well: number | null;
  n_rep: number;
  low_n: boolean;
  series: {
    mop: number[];
    is_latest_reported: boolean[];
    producing_day_frac: (number | null)[];
    oil: AccStreamSeries;
    gas: AccStreamSeries;
    water: AccStreamSeries;
  };
  // null in vintage mode (context surfaces are latest-vintage-only)
  gunbarrel: {
    frame: "dsu" | "radius";
    frame_pad_name: string | null;
    well_count: number;
    // Compass letters for the offset axis ends (W→E / N→S read).
    axis_left?: string;
    axis_right?: string;
    wells: AccGunbarrelWell[];
  } | null;
}

export async function fetchAccWells(
  basin: string,
  vintage: AccVintage = null,
): Promise<AccWellsResponse> {
  const q = new URLSearchParams({ basin });
  if (vintage) q.set("vintage", vintage);
  const r = await fetch(`/api/accuracy/wells?${q.toString()}`);
  if (!r.ok) throw new Error(`accuracy wells failed: ${r.status}`);
  return r.json();
}

export async function fetchAccSummary(p: {
  basin: string;
  tier: AccTier;
  stream: string;
  norm: AccNorm;
  horizon: number;
  bench: string[];
  operator: string[];
  vintage?: AccVintage;
}): Promise<AccSummary> {
  const q = new URLSearchParams({
    basin: p.basin, tier: p.tier, stream: p.stream, norm: p.norm,
    horizon: String(p.horizon),
  });
  if (p.vintage) q.set("vintage", p.vintage);
  for (const b of p.bench) q.append("bench", b);
  for (const o of p.operator) q.append("operator", o);
  const r = await fetch(`/api/accuracy/summary?${q.toString()}`);
  if (!r.ok) throw new Error(`accuracy summary failed: ${r.status}`);
  return r.json();
}

// Regional bias grid: mean error per map cell (choropleth).
export interface AccGrid {
  basin: string;
  stream: string;
  norm: AccNorm;
  horizon: number;
  cell_deg: number;
  cell_count: number;
  cells: GeoJSON.FeatureCollection;
}

export async function fetchAccGrid(p: {
  basin: string;
  tier: AccTier;
  stream: string;
  norm: AccNorm;
  horizon: number;
  bench: string[];
  operator: string[];
  vintage?: AccVintage;
}): Promise<AccGrid> {
  const q = new URLSearchParams({
    basin: p.basin, tier: p.tier, stream: p.stream, norm: p.norm,
    horizon: String(p.horizon),
  });
  if (p.vintage) q.set("vintage", p.vintage);
  for (const b of p.bench) q.append("bench", b);
  for (const o of p.operator) q.append("operator", o);
  const r = await fetch(`/api/accuracy/grid?${q.toString()}`);
  if (!r.ok) throw new Error(`accuracy grid failed: ${r.status}`);
  return r.json();
}

// Aggregate forecast-vs-actual for a drawn AOI (lasso/box selection).
export interface AccSelStream {
  mop: number[];
  n: number[];
  actual_perft: (number | null)[];
  fcst_perft: (number | null)[];
  bias: (number | null)[];
  mae: (number | null)[];
  n_raw: number[];
  actual_raw: (number | null)[];
  fcst_raw: (number | null)[];
}
export interface AccSelWell {
  api10: string;
  tier: "direct" | "proxy" | "unmatched";
  operator: string | null;
  formation_blueox: string;
  n_months: number;
  low_n: boolean;
  [err: string]: unknown; // err{h}_{stream}_perft
}
export interface AccSelection {
  basin: string;
  rule: string;
  well_count: number;
  direct_count: number;
  proxy_count: number;
  truncated: boolean;
  wells: AccSelWell[];
  by_month: Record<string, AccSelStream>;
}

export async function fetchAccSelection(body: {
  basin: string;
  aoi: GeoJSON.Geometry;
  rule: string;
  vintage?: AccVintage;
}): Promise<AccSelection> {
  const r = await fetch("/api/accuracy/selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`accuracy selection failed: ${r.status}`);
  return r.json();
}

export async function fetchAccWell(
  api10: string,
  vintage: AccVintage = null,
): Promise<AccWellDetail> {
  const q = new URLSearchParams({ api10 });
  if (vintage) q.set("vintage", vintage);
  const r = await fetch(`/api/accuracy/well?${q.toString()}`);
  if (!r.ok) throw new Error(`accuracy well failed: ${r.status}`);
  return r.json();
}

// Property key on the wells layer for the active (horizon, stream, norm).
export function accErrProp(horizon: number, stream: string, norm: AccNorm): string {
  return `err${horizon}_${stream}${norm === "perft" ? "_perft" : ""}`;
}
