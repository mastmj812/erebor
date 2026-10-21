// Single-location BOX workup (Map tab, bottom window "Workup"): GET /api/box/location.
// Backend: app/api/workup.py. How ONE location's record-run forecast was built — the EUR
// chain, the type curve against its named analogs, the cohort's flags, and the context the
// cohort does not show (nearby same-bench producers NOT used, same-bench BOX neighbours).

import type { BoxGroup } from "./highgrade";

export type WorkupStream = "oil" | "gas" | "water";

export interface WorkupChain {
  cohort_p50_per_kft: number; // analog cohort P50 EUR per 1,000 ft (before haircut / proximity)
  lateral_mult: number;       // lateral multiplier applied (Cui & Cross below 7,500 ft, D50)
  linear_mult: number | null; // lateral / 1,000
  cui_cross: boolean;
  haircut: number;            // walk-forward EUR factor (1.0 = none)
  prox_factor: number;        // D113 multi-parent oil factor (1.0 = as-is)
  eur: number;
  eur_per_ft: number | null;
  check: boolean;             // the product reproduces the stored EUR (< 0.1 %)
}

export interface WorkupStreamFit {
  tier: string | null; eur: number | null; eur_per_kft: number | null; cum12: number | null; cum24: number | null;
  qi: number | null; di_nominal: number | null; di_eff_1yr: number | null; b: number | null; df: number | null;
  model_type: string | null; peak_month: number | null; basis: string | null; haircut_method: string | null;
}

export interface WorkupAnalog {
  rank: number; api10: string; dist_ft: number; lateral_ft: number | null; first_production: string | null;
  transfer: boolean | null; well_name: string | null; operator: string | null; formation_blueox: string | null;
  months_observed: number | null; oil_cum12_per_kft: number | null; oil_cum24_per_kft: number | null;
  actual: Record<WorkupStream, (number | null)[] | null>; // calendar monthly volume per 1,000 ft
}

export interface WorkupNearby {
  api10: string; well_name: string; operator: string | null; lateral_ft: number | null; first_production: string | null;
  dist_ft: number; months_observed: number | null; oil_cum12_per_kft: number | null;
}

export interface WorkupNeighbour {
  stick_id: number; unique_id: string; coverage: string; lateral_ft: number | null; n_analogs: number | null;
  radius_mi: number | null; oil_eur_ft: number | null; prox_factor: number | null; dist_ft: number;
}

export interface WorkupBand { p10: (number | null)[]; p50: (number | null)[]; p90: (number | null)[]; n: number[] }

export interface LocationWorkup {
  run: { run_id: number; report_version: string; data_through: string };
  location: {
    stick_id: number; unique_id: string; formation_blueox: string | null; operator: string | null; ll_ft: number | null;
    tvd: number | null; pad_name: string | null; coverage: string; tier: "validated" | "provisional" | null;
    group: string | null; location_id: number | null; lateral_ft: number | null; planned_spacing_ft: number | null;
    spacing_source: string | null; search_mode: string | null; radius_mi: number | null; radius_class: string | null;
    n_analogs: number | null; flags: string[] | null;
  };
  streams: Partial<Record<WorkupStream, WorkupStreamFit>>;
  chain: Partial<Record<WorkupStream, WorkupChain | null>>;
  chart: {
    months: number;
    unit: Record<WorkupStream, string>;
    forecast: Record<WorkupStream, number[] | null>; // monthly per 1,000 ft on the analog basis
    band: Record<WorkupStream, WorkupBand | null>;    // analogs' CUMULATIVE per 1,000 ft
    water_curves: (number | null)[][] | null;          // measured-water analogs, monthly per 1,000 ft
  } | null;
  analogs: WorkupAnalog[];
  nearby_pdp: WorkupNearby[];
  neighbours: WorkupNeighbour[];
  notes: string[];
  proximity: {
    outcome: string; outcome_text: string; factor: number | null; label: string | null; config_class: string | null;
    config_line: string; parents: { api10: string; well_name: string | null; parent_bench: string; cls: string; dv_ft: number; dh_ft: number }[];
  } | null;
  group: BoxGroup | null;
  water: {
    water_source: string | null; water_radius_mi: number | null; water_n_analogs: number | null; water_thin: boolean | null;
    water_wor_cum12: number | null; n_water_analogs: number; n_measured_curves: number;
  } | null;
  geo: GeoJSON.FeatureCollection;
}

export async function fetchLocationWorkup(basin: string, stickId: number): Promise<LocationWorkup> {
  const r = await fetch(`/api/box/location?basin=${basin}&stick_id=${stickId}`);
  if (!r.ok) throw new Error(`workup failed: ${r.status}`);
  return r.json();
}
