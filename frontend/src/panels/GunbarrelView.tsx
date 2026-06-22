import { useState } from "react";

import { fetchGunbarrel } from "../api/gunbarrel";
import { colorForFormation } from "../map/formations";
import { useMapStore, type GunbarrelPad, type GunbarrelWell } from "../store";

const M = { l: 46, r: 10, t: 18, b: 26 };
const MUTED_GREY = "#9ca3af";

// Shape = category: PUD = outline circle, PDP = solid circle, RES = solid triangle.
// Color = formation. A muted well (culled in the Map tab, or off the active screen
// in the Highgrade per-DSU view) renders grey, dimmed, with a dashed stroke.
function Marker({ cat, cx, cy, color, muted, onClick, onHover, onLeave }: {
  cat: string; cx: number; cy: number; color: string; muted: boolean;
  onClick?: () => void; onHover: (e: React.MouseEvent) => void; onLeave: () => void;
}) {
  const r = 5;
  // PUD and RES render hollow (formation-colored outline, no fill); PDP is solid.
  const hollow = cat === "PUD" || cat === "RES";
  const handlers = {
    style: { cursor: onClick ? ("pointer" as const) : ("default" as const) },
    onClick,
    onMouseEnter: onHover,
    onMouseMove: onHover,
    onMouseLeave: onLeave,
  };
  const paint = {
    fill: hollow ? "none" : muted ? MUTED_GREY : color,
    stroke: muted ? MUTED_GREY : hollow ? color : "#3f3f46",
    strokeWidth: hollow ? 1.6 : 0.8,
    strokeDasharray: muted ? "2 1.5" : undefined,
    opacity: muted ? 0.5 : 1,
  };
  const shape = cat === "RES"
    ? <polygon points={`${cx},${cy - r} ${cx - r},${cy + r} ${cx + r},${cy + r}`} {...paint} {...handlers} />
    : <circle cx={cx} cy={cy} r={r} {...paint} {...handlers} />;
  // A larger transparent hit area makes the marker easy to hover / click.
  return (
    <g>
      <circle cx={cx} cy={cy} r={r + 4} fill="transparent" stroke="none" {...handlers} />
      {shape}
    </g>
  );
}

// Styled tooltip pinned to the cursor in VIEWPORT space (position: fixed). Fixed
// positioning keeps it out of the chart's scroll box, so a tooltip near the edge
// can't expand win-body's scrollable area (which would flicker a scrollbar and
// retrigger the ResizeObserver -> chart glitch). Flips near the viewport edges.
function GbTooltip({ w, x, y, muted, interactive, metricLabel, formatMetric }: {
  w: GunbarrelWell; x: number; y: number; muted: boolean; interactive: boolean;
  metricLabel?: string; formatMetric?: (v: number) => string;
}) {
  const flipX = x > window.innerWidth - 220;
  const flipY = y > window.innerHeight - 150;
  const PAD = 14;
  const style: React.CSSProperties = {
    ...(flipX ? { right: window.innerWidth - x + PAD } : { left: x + PAD }),
    ...(flipY ? { bottom: window.innerHeight - y + PAD } : { top: y + PAD }),
  };
  const status = interactive
    ? (muted ? "culled" : null)
    : (muted ? "off current screen" : "matches screen");
  const metricCell = metricLabel
    ? (w.metric_value != null && formatMetric ? formatMetric(w.metric_value) : "—")
    : null;
  return (
    <div className="gb-tip" style={style}>
      <div className="gb-tip-name">{w.unique_id}</div>
      <table className="gb-tip-tbl">
        <tbody>
          <tr><td>Category</td><td>{w.category}</td></tr>
          <tr><td>Formation</td><td>{w.formation}</td></tr>
          <tr><td>TVD</td><td>{Math.round(w.tvd).toLocaleString()} ft</td></tr>
          <tr><td>Offset</td><td>{Math.round(w.offset_ft).toLocaleString()} ft</td></tr>
          {w.ll_ft != null && <tr><td>Lateral</td><td>{Math.round(w.ll_ft).toLocaleString()} ft</td></tr>}
          {metricLabel && <tr><td>{metricLabel}</td><td>{metricCell}</td></tr>}
        </tbody>
      </table>
      {status && <div className="gb-tip-status">{status}</div>}
    </div>
  );
}

// Reusable single-pad cross-section. `isMuted` decides which wells render greyed;
// `onToggle` (optional) makes markers clickable (Map-tab culling). `exForm` drops
// formation-excluded wells entirely (Map-tab rollup); pass an empty set to keep all.
export function PadChart({ pad, exForm, isMuted, onToggle, width, height, metricLabel, formatMetric }: {
  pad: GunbarrelPad; exForm: Set<string>;
  isMuted: (w: GunbarrelWell) => boolean;
  onToggle?: (id: number) => void; width: number; height: number;
  metricLabel?: string; formatMetric?: (v: number) => string;
}) {
  const [hover, setHover] = useState<{ w: GunbarrelWell; x: number; y: number } | null>(null);
  const wells = pad.wells.filter((w) => !exForm.has(w.formation));
  if (!wells.length) return null;
  const offs = wells.map((w) => w.offset_ft);
  const tvds = wells.map((w) => w.tvd);
  const xmin = Math.min(...offs), xmax = Math.max(...offs);
  const ymin = Math.min(...tvds), ymax = Math.max(...tvds);
  const xr = xmax - xmin || 1, yr = ymax - ymin || 1;
  const iw = width - M.l - M.r, ih = height - M.t - M.b;
  const sx = (o: number) => M.l + (((o - xmin) / xr) * 0.9 + 0.05) * iw;
  const sy = (t: number) => M.t + (((t - ymin) / yr) * 0.9 + 0.05) * ih; // deeper = lower

  return (
    <div className="gb-chart" style={{ position: "relative", width, height }}>
      <svg width={width} height={height} style={{ background: "#fafafa", borderRadius: 4 }}>
        <text x={width / 2} y={12} textAnchor="middle" fontSize="11" fontWeight="600" fill="#27272a">
          {pad.pad_name} ({wells.length})
        </text>
        <text x={M.l - 5} y={M.t + 4} textAnchor="end" fontSize="9" fill="#71717a">{Math.round(ymin)}</text>
        <text x={M.l - 5} y={height - M.b} textAnchor="end" fontSize="9" fill="#71717a">{Math.round(ymax)}</text>
        <text x={10} y={height / 2} fontSize="9" fill="#52525b" transform={`rotate(-90 10 ${height / 2})`}>TVD (ft)</text>
        {xmin <= 0 && xmax >= 0 && (
          <line x1={sx(0)} y1={M.t} x2={sx(0)} y2={height - M.b} stroke="#e4e4e7" strokeDasharray="2 2" />
        )}
        <text x={width / 2} y={height - 6} textAnchor="middle" fontSize="9" fill="#52525b">offset (ft)</text>
        {wells.map((w) => {
          const cx = sx(w.offset_ft), cy = sy(w.tvd);
          return (
            <Marker key={w.stick_id} cat={w.category} cx={cx} cy={cy}
              color={colorForFormation(w.formation)} muted={isMuted(w)}
              onClick={onToggle ? () => onToggle(w.stick_id) : undefined}
              onHover={(e) => setHover({ w, x: e.clientX, y: e.clientY })}
              onLeave={() => setHover(null)} />
          );
        })}
      </svg>
      {hover && (
        <GbTooltip w={hover.w} x={hover.x} y={hover.y}
          muted={isMuted(hover.w)} interactive={!!onToggle}
          metricLabel={metricLabel} formatMetric={formatMetric} />
      )}
    </div>
  );
}

export function GunbarrelView({ width, height }: { width?: number; height?: number }) {
  const sel = useMapStore((s) => s.selection);
  const aoi = useMapStore((s) => s.aoi);
  const basin = useMapStore((s) => s.basin);
  const rule = useMapStore((s) => s.selectionRule);
  const excluded = useMapStore((s) => s.excludedFormations);
  const excludedSticks = useMapStore((s) => s.excludedSticks);
  const toggleStick = useMapStore((s) => s.toggleStick);
  const gb = useMapStore((s) => s.gunbarrel);
  const loading = useMapStore((s) => s.gunbarrelLoading);
  const st = useMapStore;

  if (!sel || !aoi) return <div className="count">Draw or upload an AOI to see the gunbarrel.</div>;

  const load = async () => {
    st.getState().setGunbarrelLoading(true);
    try {
      st.getState().setGunbarrel(await fetchGunbarrel(aoi, basin, rule));
    } catch (e) {
      console.error(e);
    } finally {
      st.getState().setGunbarrelLoading(false);
    }
  };

  if (!gb) {
    return (
      <div className="prod-load">
        <button disabled={loading} onClick={() => void load()}>
          {loading ? "Loading…" : "Load gunbarrel (offset vs TVD by pad)"}
        </button>
      </div>
    );
  }

  const W = Math.max(360, width ?? 820);
  const H = Math.max(240, height ?? 380);
  const FOOTER = 26, GAP = 8;
  const n = gb.pads.length;
  const cols = Math.max(1, Math.min(n, Math.floor(W / 380)));
  const chartW = Math.floor((W - (cols - 1) * GAP) / cols) - 1;
  const rows = Math.ceil(n / cols);
  const chartH = rows <= 1
    ? Math.max(240, H - FOOTER - 4)
    : Math.min(360, Math.max(220, Math.round(chartW * 0.8)));

  const exForm = new Set(excluded);
  const exStick = new Set(excludedSticks);
  return (
    <div className="gb-wrap">
      <div className="gb-grid">
        {gb.pads.map((pad) => (
          <PadChart key={pad.pad_name} pad={pad} exForm={exForm}
            isMuted={(w) => exStick.has(w.stick_id)} onToggle={toggleStick}
            width={chartW} height={chartH} />
        ))}
      </div>
      <div className="count">
        {gb.pads.length < gb.pad_count
          ? `showing ${gb.pads.length} of ${gb.pad_count} pads (most wells first)`
          : `${gb.pad_count} pads`} · color = formation, shape = category · click a marker to cull / restore
        <span className="gb-legend">
          <span>○ PUD</span> <span>● PDP</span> <span>△ RES</span> <span>dashed = culled</span>
        </span>
      </div>
    </div>
  );
}
