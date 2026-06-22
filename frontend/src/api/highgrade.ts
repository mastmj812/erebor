import type { GunbarrelPad, HighgradeResult } from "../store";

// Categorical filter fields (multi-select) returned by /facets.categorical.
export type CategoricalField =
  | "formation"
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

export type HighgradeMetric =
  | "npv5" | "npv10" | "npv15" | "npv20" | "npv25"
  | "pv5" | "pv10" | "pv15" | "pv20" | "pv25"
  | "oil_eur" | "gas_eur" | "well_count";
export type HighgradeAgg = "sum" | "avg" | "per_acre";

export interface HighgradeFilters {
  formation?: string[];
  operator?: string[];
  spacing_t?: string[];
  deplet_t?: string[];
  complet_t?: string[];
  rqt?: string[];
  // whitelisted column -> [min, max], either side null = unbounded
  ranges?: Record<string, [number | null, number | null]>;
}

export async function fetchFacets(basin: string): Promise<HighgradeFacets> {
  const r = await fetch(`/api/highgrade/facets?basin=${basin}`);
  if (!r.ok) throw new Error(`facets failed: ${r.status}`);
  return r.json();
}

export async function fetchHighgradePads(body: {
  basin: string;
  filters: HighgradeFilters;
  metric: HighgradeMetric;
  agg: HighgradeAgg;
}): Promise<HighgradeResult> {
  const r = await fetch("/api/highgrade/pads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`highgrade pads failed: ${r.status}`);
  return r.json();
}

// Per-DSU gunbarrel: all PUD+PDP wells in one pad, each tagged in_filter against
// the (last-applied) screen so off-filter PUDs and all PDPs render muted.
export async function fetchHighgradeGunbarrel(body: {
  basin: string;
  pad_name: string;
  filters: HighgradeFilters;
  metric: HighgradeMetric;
}): Promise<GunbarrelPad> {
  const r = await fetch("/api/highgrade/gunbarrel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`highgrade gunbarrel failed: ${r.status}`);
  return r.json();
}
