import type { ExpressionSpecification } from "maplibre-gl";

// Diverging ramp for the pad choropleth: blue (low) -> amber (mid) -> red (high).
// Single source of truth shared by the MapLibre fill paint and the legend bar.
export const HG_LOW = "#2563eb";
export const HG_MID = "#fde68a";
export const HG_HIGH = "#dc2626";
// A pad with no BOX-forecast (or, for econ, priced) location — drawn grey, never zero.
export const HG_UNVALUED = "#cbd5e1";

// Fill-color expression keyed on the per-pad `value` property, scaled to the
// result's [min, max]. Degenerate range (single pad / uniform) -> flat mid color.
// With `greyUnvalued`, pads whose `n_valued` is 0 render HG_UNVALUED instead
// (keyed on the integer count: a null `value` property is not reliably present).
// `lowIsBetter` (breakeven, capex) flips the ramp so red always = better.
export function choroplethFillColor(
  min: number | null,
  max: number | null,
  greyUnvalued = false,
  lowIsBetter = false,
): ExpressionSpecification | string {
  let ramp: ExpressionSpecification | string = HG_MID;
  if (min != null && max != null && max > min) {
    const mid = (min + max) / 2;
    const [lo, hi] = lowIsBetter ? [HG_HIGH, HG_LOW] : [HG_LOW, HG_HIGH];
    ramp = [
      "interpolate", ["linear"], ["to-number", ["get", "value"]],
      min, lo, mid, HG_MID, max, hi,
    ] as unknown as ExpressionSpecification;
  }
  if (!greyUnvalued) return ramp;
  return [
    "case", [">", ["to-number", ["coalesce", ["get", "n_valued"], 0]], 0], ramp, HG_UNVALUED,
  ] as unknown as ExpressionSpecification;
}

// CSS gradient for the legend bar (left = low value, right = high value; red = better).
export const HG_GRADIENT_CSS = `linear-gradient(to right, ${HG_LOW}, ${HG_MID}, ${HG_HIGH})`;
export const hgGradientCss = (lowIsBetter = false): string =>
  lowIsBetter ? `linear-gradient(to right, ${HG_HIGH}, ${HG_MID}, ${HG_LOW})` : HG_GRADIENT_CSS;

// Same blue -> amber -> red ramp as a plain color for SVG charts (the gunbarrel): v at
// lo..hi, mid = the amber stop; `lowIsBetter` flips it so red always = better.
function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}
export function rampColor(v: number, lo: number, mid: number, hi: number, lowIsBetter = false): string {
  const [a, z] = lowIsBetter ? [HG_HIGH, HG_LOW] : [HG_LOW, HG_HIGH];
  if (!(hi > lo)) return HG_MID;
  if (v <= mid) return mix(a, HG_MID, Math.max(0, Math.min(1, (v - lo) / Math.max(mid - lo, 1e-9))));
  return mix(HG_MID, z, Math.max(0, Math.min(1, (v - mid) / Math.max(hi - mid, 1e-9))));
}
