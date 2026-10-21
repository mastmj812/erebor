// The Map tab's location screen — ONE definition shared by the map filter (a MapLibre
// expression over the tile properties), the AOI rollup, the AOI BOX profile and the
// gunbarrel (a predicate over the /select values), so all four show the same locations.
//
// A forecast-carrying location (validated / PROVISIONAL) passes the tier, PDP-proximity and
// range screens. A forecast location with NO value for an active range fails it — it
// cannot be shown to pass (the Highgrade rule; e.g. a priced location without an IRR fails
// an IRR bound). A range never drops a location without a BOX forecast (D67): those show,
// grey, by their class (`notCovered`), never on a ramp and never as a zero.

import {
  ECON_METRICS,
  EUR_STREAMS,
  EUR_UNIT,
  FORECAST_COVERAGE,
  MAP_COVERAGE_ORDER,
  TIER_OF_COVERAGE,
  type EconMetric,
  type Tier,
} from "../api/boxMap";
import { PROX_OUTCOME_GROUP, type ProxGroup } from "../api/highgrade";
import type { SelectionStick } from "../store";

export type RangeMetric = "oil_eur_ft" | "gas_eur_ft" | "water_eur_ft" | "lateral_ft" | EconMetric;
export interface MapRange { metric: RangeMetric; lo: number | null; hi: number | null }

export const RANGE_METRICS: { value: RangeMetric; label: string; unit: string; econ: boolean }[] = [
  ...EUR_STREAMS.map((s) => ({ value: `${s}_eur_ft` as RangeMetric, label: `BOX ${s} EUR/ft`, unit: EUR_UNIT[s], econ: false })),
  { value: "lateral_ft", label: "Lateral", unit: "ft", econ: false },
  ...ECON_METRICS.map((m) => ({ value: m.value as RangeMetric, label: m.label, unit: m.unit, econ: true })),
];
export const rangeMetricInfo = (m: RangeMetric) => RANGE_METRICS.find((x) => x.value === m)!;
export const isEconMetric = (m: RangeMetric): m is EconMetric => ECON_METRICS.some((x) => x.value === m);
export const activeRanges = (rs: MapRange[]) => rs.filter((r) => r.lo != null || r.hi != null);

// Every class a Novi stick location without a BOX forecast can carry (shown grey by class).
export const NOT_COVERED_CLASSES = MAP_COVERAGE_ORDER.filter((k) => !FORECAST_COVERAGE.includes(k));

// The tile property of a range metric (api/tiles: EUR per ft rounded to 0.1, econ to 0.01).
export function tileProp(m: RangeMetric): string {
  return m === "lateral_ft" ? "ll_ft" : isEconMetric(m) ? `econ_${m}` : m;
}

// The econ columns the tiles must carry: the color metric (econ mode) + every active econ range.
// Sorted, so the tile URL (and its server-side cache key) does not depend on the order.
export function tileEconMetrics(colorEcon: EconMetric | null, ranges: MapRange[]): EconMetric[] {
  const s = new Set<EconMetric>(colorEcon ? [colorEcon] : []);
  for (const r of activeRanges(ranges)) if (isEconMetric(r.metric)) s.add(r.metric);
  return [...s].sort();
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// One /select stick's value for a range metric, rounded exactly as the tile carries it, so
// the map and the rollup agree on a location sitting on a bound.
export function stickValue(s: SelectionStick, m: RangeMetric): number | null {
  if (m === "lateral_ft") return s.ll_ft;
  if (isEconMetric(m)) {
    const v = s[`econ_${m}` as keyof SelectionStick];
    return typeof v === "number" ? round(v, 2) : null;
  }
  const k = s[`${m.replace("_eur_ft", "")}_eur_per_kft` as keyof SelectionStick];
  return typeof k === "number" ? round(k / 1000, 1) : null;
}

export interface ScreenOpts { tiers: Tier[]; prox: ProxGroup[]; ranges: MapRange[] }

const coveragesOf = (tiers: Tier[]) => tiers.map((t) => (t === "validated" ? "covered" : "covered_provisional"));
const outcomesOf = (prox: ProxGroup[]) => Object.entries(PROX_OUTCOME_GROUP).filter(([, g]) => prox.includes(g)).map(([k]) => k);

// Predicate form (rollup / profile / gunbarrel).
export function passesForecastScreen(
  coverage: string | null | undefined,
  proxOutcome: string | null | undefined,
  valueOf: (m: RangeMetric) => number | null,
  o: ScreenOpts,
): boolean {
  const t = coverage ? TIER_OF_COVERAGE[coverage] : undefined;
  if (!t || !o.tiers.includes(t)) return false;
  if (o.prox.length && !(proxOutcome && o.prox.includes(PROX_OUTCOME_GROUP[proxOutcome]))) return false;
  return activeRanges(o.ranges).every((r) => {
    const v = valueOf(r.metric);
    return v != null && (r.lo == null || v >= r.lo) && (r.hi == null || v <= r.hi);
  });
}

export const stickPasses = (s: SelectionStick, o: ScreenOpts) =>
  passesForecastScreen(s.coverage, s.prox_outcome, (m) => stickValue(s, m), o);

// MapLibre form of passesForecastScreen, over the tile properties (MVT omits NULLs, so
// "no value" is `!has`).
export function forecastScreenExpr(o: ScreenOpts): unknown[] {
  const all: unknown[] = ["all", ["in", ["coalesce", ["get", "coverage"], ""], ["literal", coveragesOf(o.tiers)]]];
  if (o.prox.length) all.push(["in", ["coalesce", ["get", "prox_outcome"], ""], ["literal", outcomesOf(o.prox)]]);
  for (const r of activeRanges(o.ranges)) {
    const p = tileProp(r.metric);
    const v = ["to-number", ["get", p]];
    all.push(["has", p]);
    if (r.lo != null) all.push([">=", v, r.lo]);
    if (r.hi != null) all.push(["<=", v, r.hi]);
  }
  return all;
}
