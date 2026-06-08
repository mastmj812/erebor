import { fetchGunbarrel } from "../api/gunbarrel";
import { colorForFormation } from "../map/formations";
import { useMapStore, type GunbarrelPad } from "../store";

const M = { l: 46, r: 10, t: 18, b: 26 };

// Color = formation; shape = category (PUD circle, RES triangle, PDP square).
// Culled wells render hollow (white fill, formation-colored outline). Click toggles.
function Marker({ cat, cx, cy, color, culled, title, onClick }: {
  cat: string; cx: number; cy: number; color: string; culled: boolean;
  title: string; onClick: () => void;
}) {
  const r = 5;
  const common = {
    fill: culled ? "#ffffff" : color,
    stroke: culled ? color : "#3f3f46",
    strokeWidth: culled ? 1.6 : 0.6,
    style: { cursor: "pointer" as const },
    onClick,
  };
  const t = <title>{title}</title>;
  if (cat === "RES") {
    return <polygon points={`${cx},${cy - r} ${cx - r},${cy + r} ${cx + r},${cy + r}`} {...common}>{t}</polygon>;
  }
  if (cat === "PDP") {
    return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} {...common}>{t}</rect>;
  }
  return <circle cx={cx} cy={cy} r={r} {...common}>{t}</circle>;
}

function PadChart({ pad, exForm, exStick, onToggle, width, height }: {
  pad: GunbarrelPad; exForm: Set<string>; exStick: Set<number>;
  onToggle: (id: number) => void; width: number; height: number;
}) {
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
      {wells.map((w) => (
        <Marker key={w.stick_id} cat={w.category} cx={sx(w.offset_ft)} cy={sy(w.tvd)}
          color={colorForFormation(w.formation)} culled={exStick.has(w.stick_id)}
          onClick={() => onToggle(w.stick_id)}
          title={`${w.unique_id} · ${w.category} · ${w.formation} · ${Math.round(w.tvd)} ft TVD · offset ${Math.round(w.offset_ft)} ft${exStick.has(w.stick_id) ? " · CULLED (click to restore)" : " · click to cull"}`} />
      ))}
    </svg>
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
          <PadChart key={pad.pad_name} pad={pad} exForm={exForm} exStick={exStick}
            onToggle={toggleStick} width={chartW} height={chartH} />
        ))}
      </div>
      <div className="count">
        {gb.pads.length < gb.pad_count
          ? `showing ${gb.pads.length} of ${gb.pad_count} pads (most wells first)`
          : `${gb.pad_count} pads`} · color = formation, shape = category · click a marker to cull / restore
        <span className="gb-legend">
          <span>● PUD</span> <span>▲ RES</span> <span>■ PDP</span> <span>○ culled</span>
        </span>
      </div>
    </div>
  );
}
