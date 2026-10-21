import type { GunbarrelPad, HighgradeResult } from "../store";

// Highgrade on BOX (overhaul step 5): Novi supplies the stick geometry and the DSU
// polygons only; every value is the BOX record run (EUR) or Steven's econ on it (display
// only, D13). Backend: app/api/highgrade.py.
export interface HighgradeFacets {
  basin: string;
  categorical: { formation_blueox: string[] };
  numeric: Record<string, { min: number | null; max: number | null }>;
  econ_priced: boolean;
}

export type HighgradeMetric =
  | "oil_eur" | "gas_eur" | "water_eur" | "oil_eur_per_kft" | "gas_eur_per_kft" | "water_eur_per_kft"
  | "pv0" | "pv10" | "pv15" | "pv20" | "pv25" | "pv30" | "irr" | "be_wti" | "capex"
  | "well_count";
export type HighgradeAgg = "sum" | "avg" | "per_acre";

// Mirrors backend highgrade.METRICS. `econ` = Steven's columns (need a priced record run);
// `lowIsBetter` flips the pad ramp so red always = better.
export interface HgMetricInfo {
  value: HighgradeMetric; label: string; econ?: boolean; lowIsBetter?: boolean;
}
export const HG_METRICS: HgMetricInfo[] = [
  { value: "oil_eur_per_kft", label: "Oil EUR / ft" },
  { value: "gas_eur_per_kft", label: "Gas EUR / ft" },
  { value: "water_eur_per_kft", label: "Water EUR / ft" },
  { value: "oil_eur", label: "Oil EUR" },
  { value: "gas_eur", label: "Gas EUR" },
  { value: "water_eur", label: "Water EUR" },
  { value: "pv0", label: "PV0", econ: true },
  { value: "pv10", label: "PV10", econ: true },
  { value: "pv15", label: "PV15", econ: true },
  { value: "pv20", label: "PV20", econ: true },
  { value: "pv25", label: "PV25", econ: true },
  { value: "pv30", label: "PV30", econ: true },
  { value: "irr", label: "IRR", econ: true },
  { value: "be_wti", label: "Breakeven WTI @ PV20", econ: true, lowIsBetter: true },
  { value: "capex", label: "Capex", econ: true, lowIsBetter: true },
  { value: "well_count", label: "Location count" },
];
export const hgMetricInfo = (m: string): HgMetricInfo | undefined => HG_METRICS.find((x) => x.value === m);
export const hgMetricLabel = (m: string): string => hgMetricInfo(m)?.label ?? m;
export const isMoneyMetric = (m: string): boolean => /^pv\d+$/.test(m) || m === "capex";
export const isPerKftMetric = (m: string): boolean => m.endsWith("_per_kft");
export const isMedianMetric = (m: string): boolean => m === "irr" || m === "be_wti";

// The aggregation the backend applied (highgrade.resolve_agg) -> a short label.
export function hgAggLabel(agg: string): string {
  return agg === "lateral_weighted" ? "lateral-weighted / pad"
    : agg === "median" ? "median / pad"
    : agg === "per_acre" ? "per acre"
    : agg === "avg" ? "avg / location"
    : agg === "count" ? "per pad"
    : "sum / pad";
}

// One formatter for a pad / location value (panel, legend, popup, gunbarrel). Money arrives
// in $ (Steven's $MM x 1e6), IRR in %, breakeven in $/bbl WTI, EUR in bbl / mcf; per-1,000-ft
// values are shown per FOOT (bbl/ft, mcf/ft), like the Map tab.
export function fmtHgValue(v: number | null | undefined, metric: string, agg = "sum", short = false): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (metric === "well_count") return Math.round(v).toLocaleString();
  if (isMoneyMetric(metric)) {
    const sign = v < 0 ? "−" : "";
    const a = Math.abs(v);
    if (agg === "per_acre") return `${sign}$${Math.round(a).toLocaleString()}/ac`;
    const mm = a / 1e6;
    return `${sign}$${mm >= 100 || short ? Math.round(mm).toLocaleString() : mm.toFixed(1)}MM`;
  }
  if (metric === "irr") return `${v.toFixed(short ? 0 : 1)}%`;
  if (metric === "be_wti") return `$${v.toFixed(short ? 0 : 1)}/bbl`;
  if (isPerKftMetric(metric)) return `${(v / 1000).toFixed(1)} ${metric.startsWith("gas") ? "mcf" : "bbl"}/ft`;
  const gas = metric.startsWith("gas");
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)} ${gas ? "Bcf" : "MMbbl"}`;
  return `${short && Math.abs(v) >= 1e3 ? `${Math.round(v / 1e3)}k` : Math.round(v).toLocaleString()} ${gas ? "mcf" : "bbl"}`;
}

// One priced case in box_econ.box_pud_econ (Steven's deck + assumption set).
export interface EconDeck { deck_id: string; assumption_set_id: string }

export interface HighgradeFilters {
  formation_blueox?: string[];
  // PDP-proximity outcome groups (backend box_locations.PROX_GROUPS)
  prox?: ProxGroup[];
  // whitelisted column -> [min, max] in stored units, either side null = unbounded
  ranges?: Record<string, [number | null, number | null]>;
}

// Coverage classes, in display order (backend app/box_locations.py COVERAGE_CLASSES; the
// Map / Highgrade class not_screened is added in api/boxMap.ts MAP_COVERAGE_LABELS).
export const COVERAGE_LABELS: Record<string, string> = {
  covered: "covered — validated (BOX forecast)",
  covered_provisional: "covered — PROVISIONAL tier (BOX forecast, D105)",
  not_covered_no_analogs: "no analogs at the 20-mi cap (D74)",
  not_covered_no_precedent: "no forecast — configuration without drilled precedent (D114)",
  not_covered_outside_extent: "outside the BOX extent",
  not_covered_wcxy: "WCXY target, not covered by this run (D61)",
  not_covered_unvalidated: "bench not yet validated (D60)",
  not_covered_emerging: "emerging bench (D2)",
  bench_not_in_box: "bench not in BOX v1",
  realized: "realized per reconciliation",
  no_box_row: "no BOX row (vintage drift?)",
};

// PDP-proximity layer (record run 14, D112–D116): the three Highgrade filter values over
// box.pud_proximity.outcome. A PUD BOX never measured (outside the extent, emerging, …) matches none.
export type ProxGroup = "as_is" | "haircut" | "no_precedent";
export const PROX_GROUP_LABELS: Record<ProxGroup, string> = {
  as_is: "as-is (unexposed / single parent)",
  haircut: "oil haircut (multi-parent, D113)",
  no_precedent: "no precedent — no forecast (D114)",
};
export const PROX_OUTCOME_GROUP: Record<string, ProxGroup> = {
  as_is_unexposed: "as_is", as_is_single_parent: "as_is", haircut: "haircut",
  no_forecast_precedent: "no_precedent", no_forecast_package: "no_precedent",
};
// The run-level proximity disclosure (backend box.proximity_block; null on runs before 11).
export interface BoxProximity {
  method: string | null; decisions: string | null; table_ref: string | null;
  label: "validated_with_exception";
  verdict_as_written: string | null; accepted_as: string | null; confirmation: string | null; prereg_commit: string | null;
  survivorship: string | null;
  counts: Record<string, number>;
  source_run: number | null;
  oil_eur_mmbbl_before: number | null; oil_eur_mmbbl_after: number | null; oil_eur_change: number | null;
}
// One named parent behind a PUD's configuration (box.pud_proximity_parent).
export interface BoxPadParent {
  location_id: number; stick_id: number; api10: string; cls: "same" | "topfill" | "underfill"; parent_bench: string;
  dv_ft: number; dh_ft: number; dxy_ft: number; overlap: number; age_days: number; permit: boolean;
  well_name: string | null; operator: string | null;
}

export interface BoxDeck extends EconDeck {
  downtime_basis: string;
  n_priced: number;
  n_unpriced: number;
  wti: number | null;
  hh: number | null;
  built_at: string | null;
  pushed_at?: string | null; // when Steven pushed this case (provenance, D13)
  pushed_by?: string | null;
}
export interface BoxDisclosureRow {
  stream: string; horizon: string;
  measured_bias: number | null; packages: number | null;
  haircut: number; holdout_bias_after: number | null; holdout_packages: number | null;
  // D92 runs: the realised cumulative factor across covered PUDs (null on pre-D92 runs, where it = haircut)
  realised_median: number | null; realised_p10: number | null; realised_p90: number | null;
  // step-9c groups (BS2_S, WCXY): D100 disclosed bias (= tuning bias), frozen D99 interval, record variant
  record_variant?: string | null; disclosed_bias?: number | null; d99_interval?: [number, number] | null;
}
// The coverage classes that carry a BOX forecast (backend box.FORECAST_CLASSES): covered = the
// VALIDATED tier, covered_provisional = the PROVISIONAL tier (D105). Counted apart, never summed silently.
export const FORECAST_CLASSES = ["covered", "covered_provisional"];
export const isForecastClass = (c: string | null | undefined) => c != null && FORECAST_CLASSES.includes(c);
// One step-15 disclosure line: bias (actual ÷ forecast − 1, negative = forecast HIGH) with its 95 % range.
export interface BoxTierLine {
  label: string; scope: string; stream: string; horizon: number; packages: number;
  bias: number; range_95: [number, number] | null;
}
// One coverage group of the record run (D103 by_bench): WCA, BS2_S, WCXY_WCA1, or a step-15 bench.
export interface BoxGroup {
  group: string; label: string; formations: string[]; spec: string; radius_basis: string;
  disclosure: BoxDisclosureRow[];
  haircut_method: BoxHaircutMethod;
  radius_ranges: BoxRadiusRange[];
  calendar_factor: Record<string, Record<string, number>>;
  // evidence tier (D105); absent on a pre-step-15 backend = validated
  tier?: "validated" | "provisional";
  tier_label?: string | null;        // why the group is provisional
  holdout?: string | null;           // the one-time D99 result, or "none (D105 …)"
  holdout_failed?: boolean;          // show the holdout line beside the pooled one, never the pooled alone
  lead?: { label: string; scope: string } | null;
  lines?: BoxTierLine[];
  latest_vintage_text?: string | null;
  error_convention?: string;
  water?: BoxWaterBlock | null;      // the group's water disclosure (D110); null on a run without water
}
// A group's WATER disclosure (engineering_db D107-D110): tier, and per horizon the tuning / holdout / pooled
// package bias (actual ÷ forecast − 1, negative = forecast HIGH) — shown together, never the pooled alone.
export interface BoxWaterLine {
  horizon: string;
  tuning_bias: number | null; tuning_packages: number | null;
  holdout_bias: number | null; holdout_packages: number | null;
  pooled_bias: number | null; pooled_packages: number | null;
}
export interface BoxWaterBlock {
  method: string | null; oil_basis: string | null; tier: "validated" | "provisional" | null;
  caveat: string | null; lines: BoxWaterLine[];
}
// How the run applied its haircut (backend box.haircut_method): D92 = smooth rate factor fitted to the
// D62 targets, held at `tail` after month 48; method null = D62 as built (linear cumulative factor).
export interface BoxHaircutMethod {
  method: string | null;
  tail: Record<string, number | null> | null;
  eur_factor: Record<string, number | null> | null;
}
export interface BoxRadiusRange {
  radius_class: string; horizon: string; low: number; high: number; bias: number; packages: number;
}
export interface BoxRun {
  run_id: number; report_version: string; data_through: string; code_sha: string;
  engine_sha?: string; dealintake_config?: number; created_at?: string;
  counts?: Record<string, number>; notes?: string | null;
}
export interface BoxMeta {
  basin: string;
  run: BoxRun;
  disclosure: BoxDisclosureRow[];
  haircut_method: BoxHaircutMethod;
  radius_ranges: BoxRadiusRange[];
  calendar_factor: Record<string, Record<string, number>>;
  groups?: BoxGroup[];
  proximity?: BoxProximity | null;
  decks: BoxDeck[];
  intel_report_versions: string[];
  stale: boolean;
  scope: { bench: string; in_scope: boolean; member_benches: string[]; reason: string }[];
  // Map tab (overhaul step 3): econ only for the record run — "not_yet_priced" until Steven pushes it
  econ_status?: "priced" | "not_yet_priced";
  default_deck?: string | null;
  basin_coverage?: Record<string, number>; // the basin's PUDs per coverage class in the record run
  forecast_count?: number;                 // covered + covered_provisional in the basin (0 = Midland today)
}

export interface BoxPadLocation {
  stick_id: number; unique_id: string; formation_blueox: string; ll_ft: number | null;
  novi_oil_eur: number | null; novi_gas_eur: number | null; novi_oil_eur_per_kft: number | null;
  recon_status: string | null; coverage: string; group?: string | null; tier?: "validated" | "provisional" | null;
  location_id: number | null; lateral_ft: number | null; completed_lateral_ft: number | null;
  planned_spacing_ft: number | null; spacing_source: string | null;
  search_mode: string | null; radius_mi: number | null; radius_class: string | null;
  n_analogs: number | null; flags: string[] | null;
  oil_eur: number | null; oil_eur_raw: number | null; oil_haircut: number | null;
  oil_eur_per_kft: number | null; oil_cum12: number | null; oil_cum24: number | null;
  gas_eur: number | null; gas_eur_per_kft: number | null;
  oil_di_nominal: number | null; oil_di_eff_1yr: number | null; oil_b: number | null;
  gas_di_nominal: number | null; gas_di_eff_1yr: number | null; gas_b: number | null;
  // PDP proximity (box.pud_proximity; null when BOX did not measure this PUD)
  oil_prox_factor?: number | null;
  prox_outcome?: string | null; prox_outcome_text?: string | null; prox_config_line?: string | null;
  prox_config_class?: string | null; prox_factor?: number | null; prox_label?: string | null;
  prox_haircut_key?: string | null; prox_pair_key?: string | null;
  prox_prec_multi?: number | null; prox_prec_package?: number | null;
  prox_n_same?: number | null; prox_n_topfill?: number | null; prox_n_underfill?: number | null; prox_n_parents?: number | null;
  prox_flanked_same?: boolean | null; prox_flanked_topfill?: boolean | null; prox_flanked_underfill?: boolean | null;
  prox_n_permit_parents?: number | null; prox_n_recent_producers?: number | null;
  // water (sql/62): its own tier + measured-water provenance; null on a run without water
  water_eur?: number | null; water_eur_per_kft?: number | null; water_cum12?: number | null;
  water_tier?: "validated" | "provisional" | null; water_source?: "measured" | "calculated_fallback" | null;
  water_radius_mi?: number | null; water_n_analogs?: number | null; water_thin?: boolean | null;
  water_nm_share?: number | null; water_wor_cum12?: number | null;
}
export interface BoxWaterAnalog {
  api10: string; nearest_ft: number; used_by: number; state_code: string | null; water_label: string;
  first_production: string | null; well_name: string | null; operator: string | null; lateral_ft: number | null;
}
export interface BoxChart {
  months: number; unit: string; n_analog_curves: number;
  forecast: { location_id: number; stick_id: number; tier?: "validated" | "provisional" | null; cum_per_kft: number[] }[];
  analog_band: { p10: (number | null)[]; p50: (number | null)[]; p90: (number | null)[]; n: number[] } | null;
}
export interface BoxPadAnalog {
  api10: string; nearest_ft: number; used_by: number; lateral_ft: number | null;
  first_production: string | null; transfer: boolean; well_name: string | null; operator: string | null;
}
export interface BoxPad {
  basin: string; pad_key: string; run: BoxRun;
  locations: BoxPadLocation[];
  analogs: BoxPadAnalog[];
  chart: BoxChart | null;
  water_analogs?: BoxWaterAnalog[];
  water_chart?: BoxChart | null;
  disclosure: BoxDisclosureRow[];
  haircut_method: BoxHaircutMethod;
  radius_ranges: BoxRadiusRange[];
  calendar_factor: Record<string, Record<string, number>>;
  groups?: BoxGroup[];
  tier_counts?: { validated: number; provisional: number };
  proximity?: BoxProximity | null;
  parents?: BoxPadParent[];
}

export async function fetchFacets(basin: string, deck: string | null): Promise<HighgradeFacets> {
  const q = new URLSearchParams({ basin });
  if (deck) q.set("deck", deck);
  const r = await fetch(`/api/highgrade/facets?${q.toString()}`);
  if (!r.ok) throw new Error(`facets failed: ${r.status}`);
  return r.json();
}

export async function fetchHighgradePads(body: {
  basin: string;
  filters: HighgradeFilters;
  metric: HighgradeMetric;
  agg: HighgradeAgg;
  deck: string | null; // Steven's deck id; null = default (WTI 70 / HH 3)
}): Promise<HighgradeResult> {
  const r = await fetch("/api/highgrade/pads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`highgrade pads failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Per-DSU gunbarrel: every screened location + PDP in one pad, each location tagged
// in_filter against the (last-applied) screen so off-screen locations and all PDP render muted.
export async function fetchHighgradeGunbarrel(body: {
  basin: string;
  pad_key: string; // curated.intel_pad_geom key (Novi 2026Q3 DSU, or a [k/n] stray split — sql/67)
  filters: HighgradeFilters;
  metric: HighgradeMetric;
  deck: string | null;
}): Promise<GunbarrelPad> {
  const r = await fetch("/api/highgrade/gunbarrel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`highgrade gunbarrel failed: ${r.status}`);
  return r.json();
}

export async function fetchBoxMeta(basin: string): Promise<BoxMeta> {
  const r = await fetch(`/api/box/meta?basin=${basin}`);
  if (!r.ok) throw new Error(`BOX meta failed: ${r.status}`);
  return r.json();
}

export async function fetchBoxPad(basin: string, padKey: string): Promise<BoxPad> {
  const r = await fetch(`/api/box/pad?basin=${basin}&pad_key=${encodeURIComponent(padKey)}`);
  if (!r.ok) throw new Error(`BOX pad workup failed: ${r.status}`);
  return r.json();
}
