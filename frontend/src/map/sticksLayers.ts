import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FilterSpecification,
  LineLayerSpecification,
} from "maplibre-gl";

import {
  COVERAGE_COLORS,
  FORECAST_COVERAGE,
  NOT_COVERED_COLOR,
  PDP_COLOR,
  UNPRICED_COLOR,
  type BoxLegend,
  type EconMetric,
  type EurStream,
} from "../api/boxMap";
import { HG_HIGH, HG_LOW, HG_MID } from "./highgradeColors";
import { blueoxColorExpression } from "./formations";
import { forecastScreenExpr, type ScreenOpts } from "./screen";

export const INTEL_SOURCE = "intel";
export const POINTS_LAYER = "intel-points";
export const LINES_LAYER = "intel-lines";
export const POINTS_SRC_LAYER = "intel_points";
export const LINES_SRC_LAYER = "intel_lines";

// Map color modes (overhaul step 3, BOX-first): Blue Ox bench, BOX coverage / tier,
// BOX EUR per foot (one stream), or Steven's econ (one metric, one deck; display-only).
export type ColorMode = "bench" | "coverage" | "eur" | "econ";

// Selected sticks (feature-state, keyed by stick_id via the source promoteId)
// paint yellow; everything else takes the active color mode.
const SELECTED = ["boolean", ["feature-state", "selected"], false];

const IS_PDP = ["==", ["get", "category"], "PDP"];
const IS_FORECAST = ["in", ["coalesce", ["get", "coverage"], ""], ["literal", FORECAST_COVERAGE]];

// The tile property a value color mode reads: `<stream>_eur_ft` or `econ_<metric>`.
export function valueProp(mode: ColorMode, stream: EurStream, econ: EconMetric): string | null {
  return mode === "eur" ? `${stream}_eur_ft` : mode === "econ" ? `econ_${econ}` : null;
}

// Ramp over the legend's P5 / P50 / P95 (blue -> amber -> red = better). A "lower is
// better" metric (breakeven) runs the colors the other way so red always = better.
function rampExpr(prop: string, legend: BoxLegend | null): unknown {
  const b = legend?.breaks;
  if (!b || !(b.p95 > b.p5)) return HG_MID;
  const [lo, hi] = legend!.better === "low" ? [HG_HIGH, HG_LOW] : [HG_LOW, HG_HIGH];
  const mid = Math.min(Math.max(b.p50, b.p5 + 1e-9), b.p95 - 1e-9);
  return ["interpolate", ["linear"], ["to-number", ["get", prop]], b.p5, lo, mid, HG_MID, b.p95, hi];
}

export interface ColorOpts { stream: EurStream; econ: EconMetric; legend: BoxLegend | null }

export function colorExpr(mode: ColorMode, opts: ColorOpts): ExpressionSpecification {
  let base: unknown;
  if (mode === "bench") {
    base = blueoxColorExpression();
  } else if (mode === "coverage") {
    const pairs = Object.entries(COVERAGE_COLORS).flat();
    base = ["case", IS_PDP, PDP_COLOR, ["match", ["coalesce", ["get", "coverage"], ""], ...pairs, NOT_COVERED_COLOR]];
  } else {
    const prop = valueProp(mode, opts.stream, opts.econ)!;
    base = [
      "case",
      IS_PDP, PDP_COLOR,
      ["has", prop], rampExpr(prop, opts.legend),
      IS_FORECAST, UNPRICED_COLOR, // econ mode: forecast-carrying, not priced
      NOT_COVERED_COLOR,
    ];
  }
  return ["case", SELECTED, "#facc15", base] as unknown as ExpressionSpecification;
}

const colorOrSelected = colorExpr("bench", { stream: "oil", econ: "pv10", legend: null }); // initial paint; MapView swaps it

export interface StickFilterOpts extends ScreenOpts {
  showPdp: boolean;            // producing context
  notCovered: string[];        // classes of locations WITHOUT a BOX forecast shown grey (empty = none)
  excludedFormations: string[];
  units: string[];
  formationFilter: string[];
}

// MapLibre filter. A forecast-carrying location passes the shared screen (map/screen.ts:
// tiers, proximity, every range; no value for an active range = fails). A location without a
// BOX forecast shows only when its class is in `notCovered`; PDP only with `showPdp`. Bench
// include (`formationFilter`), rollup exclude (`excludedFormations`) and the unit filter
// apply to everything, as before.
export function stickFilter(o: StickFilterOpts): FilterSpecification {
  const clauses: unknown[] = [
    ["case", IS_PDP, o.showPdp, IS_FORECAST, forecastScreenExpr(o),
      ["in", ["coalesce", ["get", "coverage"], ""], ["literal", o.notCovered]]],
  ];
  if (o.formationFilter.length > 0) {
    // Map-scouting INCLUDE filter: show only these formation_blueox codes.
    // "(unmapped)" matches features with no formation_blueox — the MVT omits null
    // props, so an absent property IS the unmapped case; mirrors the rollup's
    // COALESCE(..., '(unmapped)').
    const codes = o.formationFilter.filter((f) => f !== "(unmapped)");
    const parts: unknown[] = [];
    if (codes.length > 0) parts.push(["in", ["get", "formation_blueox"], ["literal", codes]]);
    if (o.formationFilter.includes("(unmapped)")) parts.push(["!", ["has", "formation_blueox"]]);
    clauses.push(parts.length === 1 ? parts[0] : ["any", ...parts]);
  }
  if (o.excludedFormations.length > 0) {
    clauses.push(["!", ["in", ["get", "formation_blueox"], ["literal", o.excludedFormations]]]);
  }
  if (o.units.length > 0) {
    // Match each term as a substring of unique_id, but NOT when it's immediately
    // followed by another digit — so "Eddy Unit 10" hits "...Unit 10" yet not
    // "...Unit 100/101". Uses only `in` (slice/length get rejected in filters).
    // PDP is exempt: curated producers key on api10 (no unit name), and you want
    // the producing context visible alongside a filtered unit's PUDs.
    const uid = ["get", "unique_id"];
    const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    clauses.push([
      "any",
      IS_PDP,
      ...o.units.map((u) => [
        "all",
        ["in", u, uid],
        ["!", ["any", ...digits.map((d) => ["in", u + d, uid])]],
      ]),
    ]);
  }
  if (clauses.length === 1) return clauses[0] as unknown as FilterSpecification;
  return ["all", ...clauses] as unknown as FilterSpecification;
}

export const pointsLayer: CircleLayerSpecification = {
  id: POINTS_LAYER,
  type: "circle",
  source: INTEL_SOURCE,
  "source-layer": POINTS_SRC_LAYER,
  paint: {
    "circle-color": colorOrSelected,
    "circle-opacity": 0.85,
    "circle-radius": [
      "interpolate", ["linear"], ["zoom"],
      3, 1.4,
      8, 3.5,
    ],
    "circle-stroke-color": "#a16207",
    "circle-stroke-width": ["case", SELECTED, 1.2, 0] as unknown as ExpressionSpecification,
  },
};

export const linesLayer: LineLayerSpecification = {
  id: LINES_LAYER,
  type: "line",
  source: INTEL_SOURCE,
  "source-layer": LINES_SRC_LAYER,
  paint: {
    "line-color": colorOrSelected,
    "line-opacity": 0.9,
    // Zoom interpolation MUST be the outermost expression (MapLibre rejects a
    // zoom expression nested inside `case`); the selected-width bump goes at the
    // interpolate stops instead.
    "line-width": [
      "interpolate", ["linear"], ["zoom"],
      9, ["case", SELECTED, 3.0, 1.2],
      14, ["case", SELECTED, 4.5, 3.0],
    ] as unknown as ExpressionSpecification,
  },
};

// Econ tiles carry only the metrics in use (the color metric + econ ranges, sorted) for ONE
// deck (record run only); with none in use every mode shares the plain URL, so its tiles stay
// cached across mode switches.
export function tileUrl(basin: string, econ: EconMetric[] = [], deck?: string | null): string {
  const q = new URLSearchParams({ basin });
  if (econ.length) {
    q.set("econ", econ.join(","));
    if (deck) q.set("deck", deck);
  }
  return `${window.location.origin}/api/tiles/{z}/{x}/{y}.mvt?${q.toString()}`;
}
