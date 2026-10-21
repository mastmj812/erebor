import type { ExpressionSpecification } from "maplibre-gl";

// Diverging ramp for the pad choropleth: blue (low) -> amber (mid) -> red (high).
// Single source of truth shared by the MapLibre fill paint and the legend bar.
export const HG_LOW = "#2563eb";
export const HG_MID = "#fde68a";
export const HG_HIGH = "#dc2626";
// A pad with no BOX-forecast (or, for econ, priced) location — drawn grey, never zero.
export const HG_UNVALUED = "#cbd5e1";

// The color scale of a Highgrade result: P5 -> P50 -> P95 of the drawn, valued pads
// (backend highgrade.pads_sql), so one huge stacked DSU cannot push every other pad into
// one end. Values beyond P5 / P95 clamp to the end colors. Falls back to [min, max] (mid =
// midpoint) when the percentiles are missing; a median sitting on an end stop moves to the
// midpoint so the stops stay strictly ascending. null = degenerate (flat mid color).
export interface PadScale { lo: number; mid: number; hi: number }
export function padScale(r: {
  value_min: number | null; value_max: number | null;
  value_p5?: number | null; value_p50?: number | null; value_p95?: number | null;
}): PadScale | null {
  const pct = r.value_p5 != null && r.value_p95 != null && r.value_p95 > r.value_p5;
  const lo = pct ? r.value_p5! : r.value_min;
  const hi = pct ? r.value_p95! : r.value_max;
  if (lo == null || hi == null || !(hi > lo)) return null;
  const m = pct ? r.value_p50 : null;
  return { lo, mid: m != null && m > lo && m < hi ? m : (lo + hi) / 2, hi };
}

// Fill-color expression keyed on the per-pad `value` property over a PadScale (null ->
// flat mid color). With `greyUnvalued`, pads whose `n_valued` is 0 render HG_UNVALUED
// instead (keyed on the integer count: a null `value` property is not reliably present).
// `lowIsBetter` (breakeven, capex) flips the ramp so red always = better.
export function choroplethFillColor(
  scale: PadScale | null,
  greyUnvalued = false,
  lowIsBetter = false,
): ExpressionSpecification | string {
  let ramp: ExpressionSpecification | string = HG_MID;
  if (scale) {
    const [lo, hi] = lowIsBetter ? [HG_HIGH, HG_LOW] : [HG_LOW, HG_HIGH];
    // interpolate clamps outside the first / last stop: below P5 = lo color, above P95 = hi
    ramp = [
      "interpolate", ["linear"], ["to-number", ["get", "value"]],
      scale.lo, lo, scale.mid, HG_MID, scale.hi, hi,
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
