// Minimal multi-series SVG line chart. Each series carries its own x/y arrays
// so the per-well overlay (different x extent) coexists with the aggregate
// formation curves. Linear axes; y starts at 0.
//
// X/Y zoom sliders shrink the visible axis max (anchored at the origin) so the
// user can magnify the early-time region of the decline curves. Lines are
// clipped to the plot box so zoomed-out series don't bleed past the axes.

import { useId, useState } from "react";

export interface Series {
  label: string;
  color: string;
  xs: number[];
  ys: number[];
  dashed?: boolean;
  width?: number;
}

function ticks(max: number, n = 5): number[] {
  if (max <= 0) return [0];
  const step = max / n;
  return Array.from({ length: n + 1 }, (_, i) => i * step);
}

export function LineChart({
  series, width = 540, height = 230, xlabel, ylabel,
}: {
  series: Series[]; width?: number; height?: number; xlabel: string; ylabel: string;
}) {
  // Zoom factor >= 1; visible axis max = dataMax / zoom (anchored at origin).
  const [xZoom, setXZoom] = useState(1);
  const [yZoom, setYZoom] = useState(1);
  const clipId = useId();

  // Reserve room for the vertical (y) slider on the left and the horizontal
  // (x) slider below the chart.
  const SLIDER = 18;
  const svgW = Math.max(120, width - SLIDER);
  const svgH = Math.max(120, height - SLIDER);

  const pad = { l: 58, r: 12, t: 10, b: 28 };
  const xDataMax = Math.max(1, ...series.flatMap((s) => s.xs));
  const yDataMax = Math.max(1, ...series.flatMap((s) => s.ys)) * 1.05;
  const xmax = xDataMax / xZoom;
  const ymax = yDataMax / yZoom;
  const iw = svgW - pad.l - pad.r;
  const ih = svgH - pad.t - pad.b;
  const sx = (x: number) => pad.l + (x / xmax) * iw;
  const sy = (y: number) => pad.t + ih - (y / ymax) * ih;

  const fmtY = (v: number) =>
    Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
    : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k`
    : v.toFixed(0);

  return (
    <div className="chart-wrap" style={{ width }}>
      <div className="chart-row">
        <input
          className="zoom-slider zoom-y"
          type="range" min={1} max={10} step={0.1} value={yZoom}
          title={`Y zoom ×${yZoom.toFixed(1)}`}
          onChange={(e) => setYZoom(Number(e.target.value))}
        />
        <svg width={svgW} height={svgH} style={{ font: "10px system-ui" }}>
          <defs>
            <clipPath id={clipId}>
              <rect x={pad.l} y={pad.t} width={iw} height={ih} />
            </clipPath>
          </defs>
          {/* axes */}
          <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ih} stroke="#a1a1aa" />
          <line x1={pad.l} y1={pad.t + ih} x2={pad.l + iw} y2={pad.t + ih} stroke="#a1a1aa" />
          {ticks(ymax).map((t, i) => (
            <g key={`y${i}`}>
              <line x1={pad.l - 3} y1={sy(t)} x2={pad.l + iw} y2={sy(t)} stroke="#f1f1f3" />
              <text x={pad.l - 5} y={sy(t) + 3} textAnchor="end" fill="#71717a">{fmtY(t)}</text>
            </g>
          ))}
          {ticks(xmax).map((t, i) => (
            <text key={`x${i}`} x={sx(t)} y={pad.t + ih + 16} textAnchor="middle" fill="#71717a">
              {t.toFixed(t < 10 ? 1 : 0)}
            </text>
          ))}
          <text x={pad.l + iw / 2} y={svgH - 2} textAnchor="middle" fill="#52525b">{xlabel}</text>
          <text x={12} y={pad.t + ih / 2} textAnchor="middle" fill="#52525b"
            transform={`rotate(-90 12 ${pad.t + ih / 2})`}>{ylabel}</text>
          {/* series — visible line + a fat transparent "hit" line so hovering near
              the curve shows a tooltip with the formation (or well name). */}
          <g clipPath={`url(#${clipId})`}>
            {series.map((s, i) => {
              const pts = s.xs.map((x, j) => `${sx(x).toFixed(1)},${sy(s.ys[j] ?? 0).toFixed(1)}`).join(" ");
              return (
                <g key={i}>
                  <polyline points={pts} fill="none" stroke={s.color}
                    strokeWidth={s.width ?? 1.5} strokeDasharray={s.dashed ? "4 3" : undefined}
                    style={{ pointerEvents: "none" }} />
                  <polyline points={pts} fill="none" stroke="transparent" strokeWidth={12}
                    style={{ pointerEvents: "stroke", cursor: "pointer" }}>
                    <title>{s.label}</title>
                  </polyline>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div className="chart-xzoom" style={{ paddingLeft: SLIDER + pad.l, paddingRight: pad.r }}>
        <input
          className="zoom-slider zoom-x"
          type="range" min={1} max={10} step={0.1} value={xZoom}
          title={`X zoom ×${xZoom.toFixed(1)}`}
          onChange={(e) => setXZoom(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
