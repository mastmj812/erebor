import type { ExpressionSpecification } from "maplibre-gl";

// Diverging ramp for the pad choropleth: blue (low) -> amber (mid) -> red (high).
// Single source of truth shared by the MapLibre fill paint and the legend bar.
export const HG_LOW = "#2563eb";
export const HG_MID = "#fde68a";
export const HG_HIGH = "#dc2626";
// BOX source: a pad with no covered (or, for econ, priced) PUD — drawn, never zero.
export const HG_UNVALUED = "#cbd5e1";

// Fill-color expression keyed on the per-pad `value` property, scaled to the
// result's [min, max]. Degenerate range (single pad / uniform) -> flat mid color.
// With `greyUnvalued`, pads whose `n_valued` is 0 render HG_UNVALUED instead
// (keyed on the integer count: a null `value` property is not reliably present).
export function choroplethFillColor(
  min: number | null,
  max: number | null,
  greyUnvalued = false,
): ExpressionSpecification | string {
  let ramp: ExpressionSpecification | string = HG_MID;
  if (min != null && max != null && max > min) {
    const mid = (min + max) / 2;
    ramp = [
      "interpolate", ["linear"], ["to-number", ["get", "value"]],
      min, HG_LOW, mid, HG_MID, max, HG_HIGH,
    ] as unknown as ExpressionSpecification;
  }
  if (!greyUnvalued) return ramp;
  return [
    "case", [">", ["to-number", ["coalesce", ["get", "n_valued"], 0]], 0], ramp, HG_UNVALUED,
  ] as unknown as ExpressionSpecification;
}

// CSS gradient for the legend bar (left = low, right = high).
export const HG_GRADIENT_CSS = `linear-gradient(to right, ${HG_LOW}, ${HG_MID}, ${HG_HIGH})`;
