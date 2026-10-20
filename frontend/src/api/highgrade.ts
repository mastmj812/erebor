import type { GunbarrelPad, HighgradeResult } from "../store";

// Categorical filter fields (multi-select) returned by /facets.categorical.
export type CategoricalField =
  | "formation_blueox"
  | "operator"
  | "spacing_t"
  | "deplet_t"
  | "complet_t"
  | "rqt";

export interface HighgradeFacets {
  basin: string;
  categorical: Record<CategoricalField, string[]>;
  numeric: Record<string, { min: number | null; max: number | null }>;
}

// Forecast source (BOX plan step 8): the screened PUD population is the same Novi
// set either way; only the EUR / econ numbers change.
export type ForecastSource = "novi" | "box";

export type HighgradeMetric =
  | "npv5" | "npv10" | "npv15" | "npv20" | "npv25"
  | "pv5" | "pv10" | "pv15" | "pv20" | "pv25"
  | "oil_eur" | "gas_eur" | "oil_eur_per_kft" | "gas_eur_per_kft" | "well_count"
  | "water_eur" | "water_eur_per_kft" // BOX only (sql/62)
  | "box_pv0" | "box_pv10" | "box_pv15" | "box_pv20" | "box_pv25" | "box_pv30";
export type HighgradeAgg = "sum" | "avg" | "per_acre";

export const isMoneyMetric = (m: string): boolean =>
  m.startsWith("npv") || m.startsWith("pv") || m.startsWith("box_pv");
export const isPerKftMetric = (m: string): boolean => m.endsWith("_per_kft");

// One priced case in box_econ.box_pud_econ (Steven's deck + assumption set).
export interface EconDeck { deck_id: string; assumption_set_id: string }

export interface HighgradeFilters {
  formation_blueox?: string[];
  operator?: string[];
  spacing_t?: string[];
  deplet_t?: string[];
  complet_t?: string[];
  rqt?: string[];
  // BOX PDP-proximity outcome groups (backend box.PROX_GROUPS); BOX source only
  prox?: ProxGroup[];
  // whitelisted column -> [min, max], either side null = unbounded
  ranges?: Record<string, [number | null, number | null]>;
}

// Coverage classes, in display order (backend app/api/box.py COVERAGE_CLASSES).
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

export async function fetchFacets(
  basin: string,
  includeRealized = false,
  source: ForecastSource = "novi",
): Promise<HighgradeFacets> {
  const r = await fetch(`/api/highgrade/facets?basin=${basin}&include_realized=${includeRealized}&source=${source}`);
  if (!r.ok) throw new Error(`facets failed: ${r.status}`);
  return r.json();
}

export async function fetchHighgradePads(body: {
  basin: string;
  filters: HighgradeFilters;
  metric: HighgradeMetric;
  agg: HighgradeAgg;
  include_realized: boolean;
  source: ForecastSource;
  econ?: EconDeck | null;
}): Promise<HighgradeResult> {
  const r = await fetch("/api/highgrade/pads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`highgrade pads failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Per-DSU gunbarrel: all PUD+PDP wells in one pad, each tagged in_filter against
// the (last-applied) screen so off-filter PUDs and all PDPs render muted.
export async function fetchHighgradeGunbarrel(body: {
  basin: string;
  pad_key: string; // curated.intel_pad_geom key (Novi pad_name, split by space — sql/46)
  filters: HighgradeFilters;
  metric: HighgradeMetric;
  include_realized: boolean;
  source: ForecastSource;
  econ?: EconDeck | null;
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
