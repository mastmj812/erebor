import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FilterSpecification,
  LineLayerSpecification,
} from "maplibre-gl";

import { OTHER_COLOR, formationMatchPairs } from "./formations";

export const INTEL_SOURCE = "intel";
export const POINTS_LAYER = "intel-points";
export const LINES_LAYER = "intel-lines";
export const POINTS_SRC_LAYER = "intel_points";
export const LINES_SRC_LAYER = "intel_lines";

export type Category = "PDP" | "PUD" | "RES";
export const CATEGORIES: Category[] = ["PDP", "PUD", "RES"];

// Color by formation (emitted UPPER from the backend); fallback slate.
const colorByFormation = [
  "match",
  ["get", "formation"],
  ...formationMatchPairs(),
  OTHER_COLOR,
];

// Selected sticks (feature-state, keyed by stick_id via the source promoteId)
// paint yellow; everything else keeps its formation color.
const SELECTED = ["boolean", ["feature-state", "selected"], false];
const colorOrSelected = [
  "case", SELECTED, "#facc15", colorByFormation,
] as unknown as ExpressionSpecification;

// MapLibre filter: active categories AND not-excluded formations (formation
// property is emitted UPPER; excluded list is UPPER). Empty categories -> none.
export function stickFilter(cats: Category[], excludedFormations: string[]): FilterSpecification {
  const catF =
    cats.length === 0
      ? ["==", ["get", "category"], "__none__"]
      : ["in", ["get", "category"], ["literal", cats]];
  if (excludedFormations.length === 0) {
    return catF as unknown as FilterSpecification;
  }
  return [
    "all",
    catF,
    ["!", ["in", ["get", "formation"], ["literal", excludedFormations]]],
  ] as unknown as FilterSpecification;
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
