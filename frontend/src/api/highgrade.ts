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
  // whitelisted column -> [min, max], either side null = unbounded
  ranges?: Record<string, [number | null, number | null]>;
}

// Coverage classes, in display order (backend app/api/box.py COVERAGE_CLASSES).
export const COVERAGE_LABELS: Record<string, string> = {
  covered: "covered (BOX forecast)",
  not_covered_no_analogs: "no analogs at the 20-mi cap (D74)",
  not_covered_outside_extent: "outside the BOX extent",
  not_covered_wcxy: "WCXY target, not in v1 (D61)",
  not_covered_unvalidated: "bench not yet validated (BS2_S, D60)",
  not_covered_emerging: "emerging bench (D2)",
  bench_not_in_box: "bench not in BOX v1",
  realized: "realized per reconciliation",
  no_box_row: "no BOX row (vintage drift?)",
};

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
  radius_ranges: BoxRadiusRange[];
  calendar_factor: Record<string, Record<string, number>>;
  decks: BoxDeck[];
  intel_report_versions: string[];
  stale: boolean;
  scope: { bench: string; in_scope: boolean; member_benches: string[]; reason: string }[];
}

export interface BoxPadLocation {
  stick_id: number; unique_id: string; formation_blueox: string; ll_ft: number | null;
  novi_oil_eur: number | null; novi_gas_eur: number | null; novi_oil_eur_per_kft: number | null;
  recon_status: string | null; coverage: string;
  location_id: number | null; lateral_ft: number | null; completed_lateral_ft: number | null;
  planned_spacing_ft: number | null; spacing_source: string | null;
  search_mode: string | null; radius_mi: number | null; radius_class: string | null;
  n_analogs: number | null; flags: string[] | null;
  oil_eur: number | null; oil_eur_raw: number | null; oil_haircut: number | null;
  oil_eur_per_kft: number | null; oil_cum12: number | null; oil_cum24: number | null;
  gas_eur: number | null; gas_eur_per_kft: number | null;
  oil_di_nominal: number | null; oil_di_eff_1yr: number | null; oil_b: number | null;
  gas_di_nominal: number | null; gas_di_eff_1yr: number | null; gas_b: number | null;
}
export interface BoxPadAnalog {
  api10: string; nearest_ft: number; used_by: number; lateral_ft: number | null;
  first_production: string | null; transfer: boolean; well_name: string | null; operator: string | null;
}
export interface BoxPad {
  basin: string; pad_key: string; run: BoxRun;
  locations: BoxPadLocation[];
  analogs: BoxPadAnalog[];
  chart: {
    months: number; unit: string; n_analog_curves: number;
    forecast: { location_id: number; stick_id: number; cum_per_kft: number[] }[];
    analog_band: { p10: (number | null)[]; p50: (number | null)[]; p90: (number | null)[]; n: number[] } | null;
  } | null;
  disclosure: BoxDisclosureRow[];
  radius_ranges: BoxRadiusRange[];
  calendar_factor: Record<string, Record<string, number>>;
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
