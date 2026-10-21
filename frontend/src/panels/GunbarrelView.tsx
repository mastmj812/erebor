import { useEffect, useState } from "react";

import {
  COVERAGE_COLORS,
  EUR_UNIT,
  MAP_COVERAGE_LABELS,
  NOT_COVERED_COLOR,
  PDP_COLOR,
  TIER_OF_COVERAGE,
  UNPRICED_COLOR,
  econMetricInfo,
} from "../api/boxMap";
import { fetchGunbarrel } from "../api/gunbarrel";
import {
  BLUEOX_SOURCES,
  colorForBlueox,
  colorForFormation,
  colorForSource,
} from "../map/formations";
import { HG_GRADIENT_CSS, rampColor } from "../map/highgradeColors";
import { useMapStore, type GunbarrelPad, type GunbarrelWell } from "../store";

const M = { l: 46, r: 10, t: 18, b: 26 };
const MUTED_GREY = "#9ca3af";

// Shape = category: a location (BOX-first gunbarrel: LOCATION; Highgrade / Accuracy modals:
// PUD) = outline circle, PDP = solid circle, RES (those modals only) = outline triangle.
// Color = formation. A muted well (culled in the Map tab, or off the active screen
// in the Highgrade per-DSU view) renders grey, dimmed, with a dashed stroke.
function Marker({ cat, cx, cy, color, muted, onClick, onHover, onLeave }: {
  cat: string; cx: number; cy: number; color: string; muted: boolean;
  onClick?: () => void; onHover: (e: React.MouseEvent) => void; onLeave: () => void;
}) {
  const r = 5;
  // Locations render hollow (colored outline, no fill); PDP is solid.
  const hollow = cat !== "PDP";
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
          <tr><td>Type</td><td>{w.category === "PDP" ? "producing well (PDP)" : "Novi stick location"}</td></tr>
          <tr><td>Formation</td><td>{w.formation}</td></tr>
          <tr><td>Blue Ox</td><td>
            {w.formation_blueox ?? "—"}
            {w.formation_blueox_source ? ` (${w.formation_blueox_source})` : ""}
          </td></tr>
          {w.coverage !== undefined && w.category !== "PDP" && (
            <tr><td>BOX</td><td>{w.coverage && TIER_OF_COVERAGE[w.coverage]
              ? (TIER_OF_COVERAGE[w.coverage] === "validated" ? "forecast — validated" : "forecast — PROVISIONAL")
              : `not covered: ${MAP_COVERAGE_LABELS[w.coverage ?? ""] ?? w.coverage ?? "—"}`}</td></tr>
          )}
          {w.oil_eur_ft != null && <tr><td>Oil EUR</td><td>{w.oil_eur_ft.toFixed(1)} {EUR_UNIT.oil}</td></tr>}
          {w.gas_eur_ft != null && <tr><td>Gas EUR</td><td>{w.gas_eur_ft.toFixed(1)} {EUR_UNIT.gas}</td></tr>}
          {w.water_eur_ft != null && <tr><td>Water EUR</td><td>{w.water_eur_ft.toFixed(1)} {EUR_UNIT.water}</td></tr>}
          {w.prox_outcome && <tr><td>Proximity</td><td>{w.prox_outcome.replaceAll("_", " ")}</td></tr>}
          {metricLabel && <tr><td>{metricLabel}</td><td>{metricCell}</td></tr>}
          {!metricLabel && w.econ != null && <tr><td>Econ</td><td>{w.econ.toFixed(2)} (Steven, display only)</td></tr>}
        </tbody>
      </table>
      {status && <div className="gb-tip-status">{status}</div>}
    </div>
  );
}

// Reusable single-pad cross-section. `isMuted` decides which wells render greyed;
// `onToggle` (optional) makes markers clickable (Map-tab culling). `exForm` drops
// formation-excluded wells entirely (Map-tab rollup); pass an empty set to keep all.
export function PadChart({ pad, exForm, isMuted, onToggle, width, height, metricLabel, formatMetric, colorOf }: {
  pad: GunbarrelPad; exForm: Set<string>;
  isMuted: (w: GunbarrelWell) => boolean;
  onToggle?: (id: number) => void; width: number; height: number;
  metricLabel?: string; formatMetric?: (v: number) => string;
  // Marker fill. Defaults to the legacy name-based palette (keeps the Highgrade
  // per-DSU modal unchanged); the main gun-barrel passes a Blue Ox / source fn.
  colorOf?: (w: GunbarrelWell) => string;
}) {
  const colorFn = colorOf ?? ((w: GunbarrelWell) => colorForFormation(w.formation));
  const [hover, setHover] = useState<{ w: GunbarrelWell; x: number; y: number } | null>(null);
  const wells = pad.wells.filter((w) => !exForm.has(w.formation_blueox ?? "(unmapped)"));
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
        {pad.axis_left && (
          <text x={M.l + 4} y={height - 6} textAnchor="start" fontSize="9" fill="#52525b">← {pad.axis_left}</text>
        )}
        {pad.axis_right && (
          <text x={width - M.r - 4} y={height - 6} textAnchor="end" fontSize="9" fill="#52525b">{pad.axis_right} →</text>
        )}
        {wells.map((w) => {
          const cx = sx(w.offset_ft), cy = sy(w.tvd);
          return (
            <Marker key={w.stick_id} cat={w.category} cx={cx} cy={cy}
              color={colorFn(w)} muted={isMuted(w)}
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

type GbColor = "bench" | "coverage" | "eur" | "econ" | "source";

// Main (Map-tab) gunbarrel on the BOX record run: the same visibility as the map (PDP
// context, forecast tiers, no-BOX-forecast locations only when shown), colored by bench,
// BOX coverage, BOX EUR per ft (the map's stream) or Steven's econ (the map's metric +
// deck, display only). Value ramps are scaled to the AOI's own P5 / P50 / P95.
export function GunbarrelView({ width, height }: { width?: number; height?: number }) {
  const sel = useMapStore((s) => s.selection);
  const aoi = useMapStore((s) => s.aoi);
  const basin = useMapStore((s) => s.basin);
  const rule = useMapStore((s) => s.selectionRule);
  const excluded = useMapStore((s) => s.excludedFormations);
  const excludedSticks = useMapStore((s) => s.excludedSticks);
  const toggleStick = useMapStore((s) => s.toggleStick);
  const showPdp = useMapStore((s) => s.showPdp);
  const showNotCovered = useMapStore((s) => s.showNotCovered);
  const tierFilter = useMapStore((s) => s.tierFilter);
  const eurStream = useMapStore((s) => s.eurStream);
  const econMetric = useMapStore((s) => s.econMetric);
  const mapDeck = useMapStore((s) => s.mapDeck);
  const gb = useMapStore((s) => s.gunbarrel);
  const loading = useMapStore((s) => s.gunbarrelLoading);
  const st = useMapStore;
  const [colorMode, setColorMode] = useState<GbColor>("eur");

  const load = async () => {
    if (!aoi) return;
    st.getState().setGunbarrelLoading(true);
    try {
      st.getState().setGunbarrel(await fetchGunbarrel(aoi, basin, rule, econMetric, mapDeck));
    } catch (e) {
      console.error(e);
    } finally {
      st.getState().setGunbarrelLoading(false);
    }
  };
  // The econ values belong to one metric + deck: reload a loaded gunbarrel when either changes.
  useEffect(() => {
    if (st.getState().gunbarrel) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [econMetric, mapDeck]);

  if (!sel || !aoi) return <div className="count">Draw an AOI (Lasso / Box) to see the gunbarrel.</div>;

  if (!gb) {
    return (
      <div className="prod-load">
        <button disabled={loading} onClick={() => void load()}>
          {loading ? "Loading…" : "Load gunbarrel (offset vs TVD)"}
        </button>
      </div>
    );
  }

  const W = Math.max(360, width ?? 820);
  const H = Math.max(240, height ?? 380);
  // Reserve room BELOW the chart for the footer (count + color toggle) AND the
  // swatch legend, so the legend isn't pushed into the scroll area.
  const FOOTER = 26, LEGEND_H = 56, GAP = 8;
  const exForm = new Set(excluded);
  const exStick = new Set(excludedSticks);
  // Same visibility as the map.
  const visible = (w: GunbarrelWell) => {
    if (w.category === "PDP") return showPdp;
    const t = w.coverage ? TIER_OF_COVERAGE[w.coverage] : undefined;
    return t ? tierFilter.includes(t) : showNotCovered;
  };
  const pads = gb.pads.map((p) => ({ ...p, wells: p.wells.filter(visible) }));
  const n = pads.length;
  const cols = Math.max(1, Math.min(n, Math.floor(W / 380)));
  const chartW = Math.floor((W - (cols - 1) * GAP) / cols) - 1;
  const rows = Math.ceil(n / cols);
  const chartH = rows <= 1
    ? Math.max(220, H - FOOTER - LEGEND_H - 4)
    : Math.min(360, Math.max(220, Math.round(chartW * 0.8)));

  const allWells = pads.flatMap((p) => p.wells);
  const valueOf = (w: GunbarrelWell): number | null =>
    colorMode === "eur" ? (w[`${eurStream}_eur_ft` as const] ?? null) : colorMode === "econ" ? (w.econ ?? null) : null;
  const vals = allWells.map(valueOf).filter((v): v is number => v != null).sort((a, b) => a - b);
  const q = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))] : 0);
  const [lo, mid, hi] = [q(0.05), q(0.5), q(0.95)];
  const lowBetter = colorMode === "econ" && econMetricInfo(econMetric).better === "low";
  const colorOf = (w: GunbarrelWell): string => {
    if (colorMode === "bench") return colorForBlueox(w.basin_blueox, w.formation_blueox);
    if (colorMode === "source") return colorForSource(w.formation_blueox_source);
    if (w.category === "PDP") return PDP_COLOR;
    if (colorMode === "coverage") return COVERAGE_COLORS[w.coverage ?? ""] ?? NOT_COVERED_COLOR;
    const v = valueOf(w);
    if (v != null) return rampColor(v, lo, mid, hi, lowBetter);
    return w.coverage && TIER_OF_COVERAGE[w.coverage] ? UNPRICED_COLOR : NOT_COVERED_COLOR;
  };

  // Swatch legend for the active color mode, limited to what's shown.
  const legend: { label: string; color: string }[] =
    colorMode === "source"
      ? BLUEOX_SOURCES.filter((s) => allWells.some((w) => (w.formation_blueox_source ?? "(null)") === s.key))
          .map((s) => ({ label: s.label, color: s.color }))
      : colorMode === "coverage"
      ? [...new Set(allWells.filter((w) => w.category !== "PDP").map((w) => w.coverage ?? ""))]
          .map((k) => ({ label: MAP_COVERAGE_LABELS[k] ?? k, color: COVERAGE_COLORS[k] ?? NOT_COVERED_COLOR }))
          .concat([{ label: "PDP", color: PDP_COLOR }])
      : colorMode === "bench"
      ? Array.from(new Map(allWells.filter((w) => w.formation_blueox).map((w) => [
          `${w.basin_blueox}:${w.formation_blueox}`,
          { label: w.formation_blueox as string, color: colorForBlueox(w.basin_blueox, w.formation_blueox) },
        ])).values()).sort((a, b) => a.label.localeCompare(b.label))
      : [{ label: "PDP", color: PDP_COLOR }, { label: colorMode === "econ" ? "forecast, not priced" : "no value", color: UNPRICED_COLOR }];
  const rampLabel = colorMode === "eur"
    ? `BOX ${eurStream} EUR (${EUR_UNIT[eurStream]})`
    : colorMode === "econ" ? `${econMetricInfo(econMetric).label} (${econMetricInfo(econMetric).unit}, Steven, display only)` : "";

  const modeBtn = (on: boolean): React.CSSProperties => ({
    marginLeft: 4, padding: "0 6px", fontSize: 11, cursor: "pointer",
    border: "1px solid #d4d4d8", borderRadius: 3,
    background: on ? "#27272a" : "#fff", color: on ? "#fff" : "#3f3f46",
  });
  const nForecast = allWells.filter((w) => w.coverage && TIER_OF_COVERAGE[w.coverage]).length;
  const nPdp = allWells.filter((w) => w.category === "PDP").length;

  return (
    <div className="gb-wrap">
      <div className="gb-grid">
        {pads.map((pad) => (
          <PadChart key={pad.pad_name} pad={pad} exForm={exForm}
            isMuted={(w) => exStick.has(w.stick_id)} onToggle={toggleStick}
            colorOf={colorOf} width={chartW} height={chartH} />
        ))}
      </div>
      <div className="count">
        {allWells.length} shown ({nForecast} BOX forecast · {nPdp} PDP · {allWells.length - nForecast - nPdp} no BOX forecast)
        · click a marker to cull / restore
        <span style={{ marginLeft: 10 }}>
          color:
          <button style={modeBtn(colorMode === "eur")} onClick={() => setColorMode("eur")}>BOX EUR/ft</button>
          <button style={modeBtn(colorMode === "econ")} onClick={() => setColorMode("econ")}>econ</button>
          <button style={modeBtn(colorMode === "coverage")} onClick={() => setColorMode("coverage")}>coverage</button>
          <button style={modeBtn(colorMode === "bench")} onClick={() => setColorMode("bench")}>bench</button>
          <button style={modeBtn(colorMode === "source")} onClick={() => setColorMode("source")}>bench source</button>
        </span>
        <span className="gb-legend">
          <span>○ location</span> <span>● PDP</span> <span>dashed = culled</span>
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", padding: "4px 6px", fontSize: 10, color: "#52525b" }}>
        {rampLabel && vals.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {rampLabel}: {lowBetter ? hi.toFixed(1) : lo.toFixed(1)}
            <span style={{ width: 80, height: 8, display: "inline-block", borderRadius: 2,
              background: lowBetter ? HG_GRADIENT_CSS.replace("to right", "to left") : HG_GRADIENT_CSS }} />
            {lowBetter ? lo.toFixed(1) : hi.toFixed(1)} (AOI P5–P95{lowBetter ? ", red = lower" : ""})
          </span>
        )}
        {legend.map((it) => (
          <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
            <span style={{ width: 9, height: 9, background: it.color, borderRadius: 2, display: "inline-block" }} /> {it.label}
          </span>
        ))}
      </div>
    </div>
  );
}
