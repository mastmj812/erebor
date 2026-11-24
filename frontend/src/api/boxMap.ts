// Map tab on BOX (overhaul step 3): color metrics, coverage classes and the legend
// breaks. Backend: app/box_locations.py (the one module that reads BOX attributes),
// /api/tiles (per-stick BOX properties), /api/box/legend (ramp breaks).
//
// Not covered is a stated class, never a zero (D2/D67): a not-covered stick has no
// EUR / econ property in the tile and is drawn grey, never on the ramp. Econ is
// Steven's (box_econ.box_pud_econ) for the RECORD run only, display-only (D13).

import { COVERAGE_LABELS, type ProxGroup } from "./highgrade";

export type EurStream = "oil" | "gas" | "water";
export const EUR_STREAMS: EurStream[] = ["oil", "gas", "water"];
export const EUR_UNIT: Record<EurStream, string> = { oil: "bbl/ft", gas: "mcf/ft", water: "bbl/ft" };

// Mirrors backend box_locations.ECON_METRICS (whitelist + unit + ramp direction).
export type EconMetric = "pv0" | "pv10" | "pv15" | "pv20" | "pv25" | "pv30" | "irr" | "be_wti" | "capex";
export const ECON_METRICS: { value: EconMetric; label: string; unit: string; better: "high" | "low" }[] = [
  { value: "pv0", label: "PV0", unit: "$MM", better: "high" },
  { value: "pv10", label: "PV10", unit: "$MM", better: "high" },
  { value: "pv15", label: "PV15", unit: "$MM", better: "high" },
  { value: "pv20", label: "PV20", unit: "$MM", better: "high" },
  { value: "pv25", label: "PV25", unit: "$MM", better: "high" },
  { value: "pv30", label: "PV30", unit: "$MM", better: "high" },
  { value: "irr", label: "IRR", unit: "%", better: "high" },
  { value: "be_wti", label: "Breakeven WTI @ PV20", unit: "$/bbl", better: "low" },
  { value: "capex", label: "Capex", unit: "$MM", better: "low" },
];
export const econMetricInfo = (m: EconMetric) => ECON_METRICS.find((x) => x.value === m)!;

export type Tier = "validated" | "provisional";
export const TIER_OF_COVERAGE: Record<string, Tier> = { covered: "validated", covered_provisional: "provisional" };
export const FORECAST_COVERAGE = ["covered", "covered_provisional"];

// A location is a BOX stick (the record BOX stick set, since the BOX sticks cutover). A stick
// with no row in the BOX record run is classed by our facts: on a BOX bench but never screened
// by the run, or on a bench BOX does not cover (backend box_locations.map_coverage_sql). A
// stick the nightly reconciliation calls conflict or crowded is not drillable: the run stores
// it as not_covered_conflict.
export const NOT_SCREENED = "not_screened";
export const MAP_COVERAGE_LABELS: Record<string, string> = COVERAGE_LABELS;
// The nightly reconciliation's word on a BOX stick (tile property `recon_status`; absent = not
// judged yet). A producing stick is not on the map at all. Mirrors backend BOX_STICK_STATUSES.
export const BOX_STICK_STATUSES = ["open", "permitted", "pending", "conflict", "crowded"];
export const BOX_STICK_OUT = ["conflict", "crowded"]; // not drillable -> coverage not_covered_conflict
export const MAP_COVERAGE_ORDER = [
  "covered", "covered_provisional",
  "not_covered_no_precedent", "not_covered_no_analogs", "not_covered_outside_extent",
  "not_covered_emerging", "not_covered_wcxy", "not_covered_unvalidated", "not_covered_conflict",
  NOT_SCREENED, "bench_not_in_box", "realized",
];

// Coverage color mode. Forecast classes are the two saturated colors; every
// not-covered class is a grey family (still distinguishable, never on a value ramp).
export const COVERAGE_COLORS: Record<string, string> = {
  covered: "#16a34a",
  covered_provisional: "#f59e0b",
  not_covered_no_precedent: "#a78bfa",
  not_covered_no_analogs: "#f9a8d4",
  not_covered_outside_extent: "#94a3b8",
  not_covered_emerging: "#64748b",
  not_covered_wcxy: "#94a3b8",
  not_covered_unvalidated: "#94a3b8",
  not_covered_conflict: "#f87171", // D145: conflict or crowded per the nightly reconciliation, not drillable
  bench_not_in_box: "#71717a",
  realized: "#a8a29e",
  [NOT_SCREENED]: "#a1a1aa",
};
export const PDP_COLOR = "#475569";          // producing context in the BOX color modes
// value modes: no BOX forecast. Dark enough to read on the basemap; the map draws these
// locations DASHED (lines) / as open rings (points), which is what tells them from PDP.
export const NOT_COVERED_COLOR = "#71717a";
export const UNPRICED_COLOR = "#a8a29e";     // econ mode: forecast-carrying but not priced

export const PROX_FILTER_GROUPS: ProxGroup[] = ["as_is", "haircut"]; // no_precedent = not covered

export interface BoxLegend {
  basin: string;
  metric: string;
  run_id: number;
  unit: string;
  better: "high" | "low";
  n: number;
  tier_counts: { validated: number; provisional: number } | null;
  breaks: { p5: number; p25: number; p50: number; p75: number; p95: number } | null;
  stream?: EurStream;
  econ?: EconMetric;
  label?: string;
  priced?: boolean;
  case?: { deck_id: string; assumption_set_id: string; built_at: string | null } | null;
  scope?: { benches: string[]; exclude: string[]; tiers: Tier[] };
}

// The ramp is scoped like the map: the bench include filter, the rollup's bench excludes and
// the tiers shown — so it spans what is on screen, not the whole basin.
export interface LegendScope { benches: string[]; exclude: string[]; tiers: Tier[] }

export async function fetchBoxLegend(
  basin: string, metric: string, econ: EconMetric | undefined, deck: string | null | undefined, scope: LegendScope,
): Promise<BoxLegend> {
  const q = new URLSearchParams({ basin, metric });
  if (econ) q.set("econ", econ);
  if (deck) q.set("deck", deck);
  for (const b of scope.benches) q.append("bench", b);
  for (const b of scope.exclude) q.append("exclude", b);
  for (const t of scope.tiers) q.append("tier", t);
  if (!scope.tiers.length) q.append("tier", "none"); // nothing shown: an empty scope, not the default
  const r = await fetch(`/api/box/legend?${q.toString()}`);
  if (!r.ok) throw new Error(`BOX legend failed: ${r.status}`);
  return r.json();
}

// Deck id "wti70_hh3" -> "WTI $70 / HH $3".
export function deckLabel(deckId: string, wti?: number | null, hh?: number | null): string {
  if (wti != null && hh != null) return `WTI $${wti} / HH $${hh}`;
  const m = /^wti(\d+)_hh(\d+(?:\.\d+)?)$/.exec(deckId);
  return m ? `WTI $${m[1]} / HH $${m[2]}` : deckId;
}
