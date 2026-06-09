import type { ExpressionSpecification } from "maplibre-gl";

// Diverging ramp for the pad choropleth: blue (low) -> amber (mid) -> red (high).
// Single source of truth shared by the MapLibre fill paint and the legend bar.
export const HG_LOW = "#2563eb";
export const HG_MID = "#fde68a";
export const HG_HIGH = "#dc2626";

// Fill-color expression keyed on the per-pad `value` property, scaled to the
// result's [min, max]. Degenerate range (single pad / uniform) -> flat mid color.
export function choroplethFillColor(
  min: number | null,
  max: number | null,
): ExpressionSpecification | string {
  if (min == null || max == null || !(max > min)) return HG_MID;
  const mid = (min + max) / 2;
  return [
    "interpolate", ["linear"], ["to-number", ["get", "value"]],
    min, HG_LOW, mid, HG_MID, max, HG_HIGH,
  ] as unknown as ExpressionSpecification;
}

// CSS gradient for the legend bar (left = low, right = high).
export const HG_GRADIENT_CSS = `linear-gradient(to right, ${HG_LOW}, ${HG_MID}, ${HG_HIGH})`;
