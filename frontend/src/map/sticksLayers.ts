import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FilterSpecification,
  LineLayerSpecification,
} from "maplibre-gl";

import { blueoxColorExpression, statusColorExpression } from "./formations";

export const INTEL_SOURCE = "intel";
export const POINTS_LAYER = "intel-points";
export const LINES_LAYER = "intel-lines";
export const POINTS_SRC_LAYER = "intel_points";
export const LINES_SRC_LAYER = "intel_lines";

export type Category = "PDP" | "PUD" | "RES";
export const CATEGORIES: Category[] = ["PDP", "PUD", "RES"];

export type ColorMode = "bench" | "status";

// Selected sticks (feature-state, keyed by stick_id via the source promoteId)
// paint yellow; everything else takes the active color mode (Blue Ox bench, or
// §6 reconciliation status). Same palettes as the SVG gun-barrel.
const SELECTED = ["boolean", ["feature-state", "selected"], false];

export function colorExpr(mode: ColorMode): ExpressionSpecification {
  const base = mode === "status" ? statusColorExpression() : blueoxColorExpression();
  return ["case", SELECTED, "#facc15", base] as unknown as ExpressionSpecification;
}

const colorOrSelected = colorExpr("bench"); // initial layer paint; MapView swaps it

// MapLibre filter: active categories AND not-excluded formation_blueox codes AND
// (if any) unit match. excludedFormations holds formation_blueox codes (the
// rollup/exclude dimension shared with the ResultsPanel).
// Empty categories -> none. `units` are EXACT-SUFFIX matched against unique_id
// (the unit number is the tail, so "Eddy Unit 10" matches "...Eddy Unit 10" but
// not "...Eddy Unit 100"), OR'd across terms.
export function stickFilter(
  cats: Category[],
  excludedFormations: string[],
  units: string[] = [],
  remainingOnly = false,
): FilterSpecification {
  const clauses: unknown[] = [
    cats.length === 0
      ? ["==", ["get", "category"], "__none__"]
      : ["in", ["get", "category"], ["literal", cats]],
  ];
  if (excludedFormations.length > 0) {
    // excludedFormations are formation_blueox codes (the rollup/exclude dimension).
    clauses.push(["!", ["in", ["get", "formation_blueox"], ["literal", excludedFormations]]]);
  }
  if (units.length > 0) {
    // Match each term as a substring of unique_id, but NOT when it's immediately
    // followed by another digit — so "Eddy Unit 10" hits "...Unit 10" yet not
    // "...Unit 100/101". Uses only `in` (slice/length get rejected in filters).
    // PDP is exempt: curated producers key on api10 (no unit name), and you want
    // the producing context visible alongside a filtered unit's PUDs.
    const uid = ["get", "unique_id"];
    const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    clauses.push([
      "any",
      ["==", ["get", "category"], "PDP"],
      ...units.map((u) => [
        "all",
        ["in", u, uid],
        ["!", ["any", ...digits.map((d) => ["in", u + d, uid])]],
      ]),
    ]);
  }
  if (remainingOnly) {
    // Drillable-inventory view: among PUDs keep only remaining; RES/PDP pass
    // (toggle them off via the category checkboxes for a pure remaining view).
    clauses.push([
      "any",
      ["!=", ["get", "category"], "PUD"],
      ["==", ["get", "recon_status"], "remaining_pud"],
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

export function tileUrl(basin: string): string {
  return `${window.location.origin}/api/tiles/{z}/{x}/{y}.mvt?basin=${basin}`;
}
