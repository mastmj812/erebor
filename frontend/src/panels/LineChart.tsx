// Minimal multi-series SVG line chart. Each series carries its own x/y arrays
// so the per-well overlay (different x extent) coexists with the aggregate
// formation curves. Linear axes; y starts at 0.

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
  const pad = { l: 58, r: 12, t: 10, b: 28 };
  const xmax = Math.max(1, ...series.flatMap((s) => s.xs));
  const ymax = Math.max(1, ...series.flatMap((s) => s.ys)) * 1.05;
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const sx = (x: number) => pad.l + (x / xmax) * iw;
  const sy = (y: number) => pad.t + ih - (y / ymax) * ih;

  const fmtY = (v: number) =>
    Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
    : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k`
    : v.toFixed(0);

  return (
    <svg width={width} height={height} style={{ font: "10px system-ui" }}>
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
          {t.toFixed(0)}
        </text>
      ))}
      <text x={pad.l + iw / 2} y={height - 2} textAnchor="middle" fill="#52525b">{xlabel}</text>
      <text x={12} y={pad.t + ih / 2} textAnchor="middle" fill="#52525b"
        transform={`rotate(-90 12 ${pad.t + ih / 2})`}>{ylabel}</text>
      {/* series — visible line + a fat transparent "hit" line so hovering near
          the curve shows a tooltip with the formation (or well name). */}
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
    </svg>
  );
}
