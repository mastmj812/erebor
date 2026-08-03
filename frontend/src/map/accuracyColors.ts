// Diverging color scale for forecast-vs-actual percent error.
// Red = well under-delivered vs the Novi forecast, near-white = on forecast,
// green = over-delivered. Clamped at ±50%; null/missing = grey (no data).
// Shared by the map line paint, the legend ramp, and the modal gunbarrel.

export const ACC_NULL_GREY = "#9ca3af";

// stops: [err, color]
const STOPS: [number, string][] = [
  [-0.5, "#b91c1c"], // ≥50% under — deep red
  [-0.25, "#f97316"],
  [0.0, "#f4f4f5"], // on forecast — near-white
  [0.25, "#4ade80"],
  [0.5, "#15803d"], // ≥50% over — deep green
];

function hex2rgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

// JS-side interpolation (legend swatches, gunbarrel marker fill).
export function accuracyColor(err: number | null | undefined): string {
  if (err == null || !Number.isFinite(err)) return ACC_NULL_GREY;
  const v = Math.max(STOPS[0][0], Math.min(STOPS[STOPS.length - 1][0], err));
  for (let i = 1; i < STOPS.length; i++) {
    const [x1, c1] = STOPS[i];
    if (v <= x1) {
      const [x0, c0] = STOPS[i - 1];
      const t = (v - x0) / (x1 - x0);
      const a = hex2rgb(c0), b = hex2rgb(c1);
      const mix = a.map((av, j) => Math.round(av + (b[j] - av) * t));
      return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// MapLibre line-color expression, data-driven on the given error property.
// `typeof` guards the null/absent case (interpolate on null would error).
export function accuracyLineColor(prop: string): unknown {
  return [
    "case",
    ["==", ["typeof", ["get", prop]], "number"],
    [
      "interpolate", ["linear"], ["get", prop],
      ...STOPS.flatMap(([x, c]) => [x, c]),
    ],
    ACC_NULL_GREY,
  ];
}

// Regional-grid fill: bias-colored, grey for thin cells (n < minN).
export function accuracyGridFill(minN = 3): unknown {
  return [
    "case",
    ["<", ["get", "n"], minN],
    ACC_NULL_GREY,
    [
      "interpolate", ["linear"], ["get", "bias"],
      ...STOPS.flatMap(([x, c]) => [x, c]),
    ],
  ];
}

// CSS gradient for the legend ramp (left = under, right = over).
export const ACC_GRADIENT_CSS = `linear-gradient(to right, ${STOPS.map(
  ([x, c]) => `${c} ${((x + 0.5) / 1.0) * 100}%`,
).join(", ")})`;
