import { useEffect, useRef, useState } from "react";

import type { AccSelStream, AccSelWell } from "../api/accuracy";
import { accuracyColor } from "../map/accuracyColors";
import { useMapStore, type Phase } from "../store";
import { LineChart, type Series } from "./LineChart";

const NOVI_RED = "#c0392b";
const ACTUAL_INK = "#111827";
const STREAMS: Phase[] = ["oil", "gas", "water"];
const UNITS: Record<Phase, string> = { oil: "bbl", gas: "Mcf", water: "bbl" };

function pick(mop: number[], arr: (number | null)[], scale = 1): [number[], number[]] {
  const xs: number[] = [], ys: number[] = [];
  arr.forEach((v, i) => { if (v != null) { xs.push(mop[i]); ys.push(v * scale); } });
  return [xs, ys];
}

function buildSeries(s: AccSelStream, perft: boolean): { cum: Series[]; err: Series[] } {
  const [ax, ay] = pick(s.mop, perft ? s.actual_perft : s.actual_raw);
  const [fx, fy] = pick(s.mop, perft ? s.fcst_perft : s.fcst_raw);
  const [bx, by] = pick(s.mop, s.bias, 100);
  const [mx, my] = pick(s.mop, s.mae, 100);
  return {
    cum: [
      { label: "actual", color: ACTUAL_INK, width: 2, xs: ax, ys: ay },
      { label: "Novi forecast (P50)", color: NOVI_RED, dashed: true, width: 1.8, xs: fx, ys: fy },
    ],
    err: [
      { label: "bias %", color: "#6d28d9", width: 2, xs: bx, ys: by },
      { label: "MAE %", color: "#a1a1aa", dashed: true, xs: mx, ys: my },
    ],
  };
}

// Lasso/box a set of blind wells on the Accuracy map -> this draggable window:
// aggregate forecast-vs-actual (per-well mean per-ft, or summed raw volumes on
// the direct subset), the bias/MAE trend, and a drill-down well table (click a
// row for the single-well modal).
export function AccuracySelectionModal() {
  const sel = useMapStore((s) => s.accSelection);
  const loading = useMapStore((s) => s.accSelectionLoading);
  const close = useMapStore((s) => s.clearAccSelection);
  const openWell = useMapStore((s) => s.openAccWell);
  const horizon = useMapStore((s) => s.accHorizon);
  const panelStream = useMapStore((s) => s.accStream);

  const [stream, setStream] = useState<Phase>(panelStream);
  const [perft, setPerft] = useState(true);
  const [pos, setPos] = useState(() => ({
    x: Math.max(20, Math.round(window.innerWidth * 0.5 - 380)),
    y: Math.max(40, Math.round(window.innerHeight * 0.5 - 300)),
  }));
  const [dragging, setDragging] = useState(false);
  const offset = useRef({ dx: 0, dy: 0 });

  useEffect(() => {
    if (sel) setStream(useMapStore.getState().accStream);
  }, [sel]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) =>
      setPos({ x: e.clientX - offset.current.dx, y: e.clientY - offset.current.dy });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    if (!sel && !loading) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, loading, close]);

  if (!sel && !loading) return null;

  const onHeadDown = (e: React.MouseEvent) => {
    offset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    setDragging(true);
    e.preventDefault();
  };

  const st = sel?.by_month[stream];
  const ss = st ? buildSeries(st, perft) : null;
  const unit = perft ? `${UNITS[stream]}/ft` : UNITS[stream];
  const errKey = `err${horizon}_${stream}_perft`;
  const sortedWells: AccSelWell[] = sel
    ? [...sel.wells].sort((a, b) => {
        const ea = a[errKey] as number | null, eb = b[errKey] as number | null;
        if (ea == null && eb == null) return 0;
        if (ea == null) return 1;
        if (eb == null) return -1;
        return ea - eb;
      })
    : [];
  const nAtStart = st?.n[0] ?? 0;
  const nAtEnd = st?.n[st.n.length - 1] ?? 0;

  return (
    <div className="floatwin acc-win" style={{ left: pos.x, top: pos.y }}>
      <div className="win-head" onMouseDown={onHeadDown}>
        <span className="win-title">
          ⠿ Selection{sel ? ` · ${sel.well_count} wells (${sel.direct_count} direct / ${sel.proxy_count} proxy)` : ""}
          {sel?.truncated && <span className="acc-badge acc-badge-warn">table capped at 500</span>}
        </span>
        <button className="hg-gb-close" aria-label="Close"
          onMouseDown={(e) => e.stopPropagation()} onClick={close}>×</button>
      </div>
      <div className="win-body">
        {loading && <div className="count">Selecting wells…</div>}
        {!loading && sel && sel.well_count === 0 && (
          <div className="count">No blind wells in the drawn area.</div>
        )}
        {!loading && sel && sel.well_count > 0 && (
          <>
            <div className="seg sm" style={{ marginBottom: 4 }}>
              {STREAMS.map((p) => (
                <button key={p} className={stream === p ? "active" : ""} onClick={() => setStream(p)}>
                  {p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
              <span style={{ width: 10 }} />
              <button className={perft ? "active" : ""} onClick={() => setPerft(true)}>avg per ft</button>
              <button className={!perft ? "active" : ""} onClick={() => setPerft(false)}
                title="Summed volumes over the direct-tier subset only (proxy wells have no raw forecast)">
                total raw
              </button>
            </div>

            {ss && (
              <div className="acc-charts">
                <LineChart series={ss.cum} width={340} height={220}
                  xlabel="months on production"
                  ylabel={perft ? `avg cum ${stream} (${unit}/well)` : `total cum ${stream} (${unit}, direct only)`} />
                <LineChart series={ss.err} width={340} height={220} signedY
                  xlabel="months on production" ylabel="% error (per-ft basis)" />
              </div>
            )}
            <div className="count" style={{ margin: "0 0 8px" }}>
              solid = actual · dashed = Novi P50 · both curves cover the same wells at each month
              · n declines with reporting lag: {nAtStart} wells at month 1 → {nAtEnd} at month {st?.mop[st.mop.length - 1]}
              {!perft && sel.direct_count < sel.well_count && (
                <> · raw totals cover the {sel.direct_count} direct wells only</>
              )}
            </div>

            <table className="acc-table">
              <thead>
                <tr style={{ color: "#71717a" }}>
                  <td>api10</td><td>tier</td><td>bench</td><td>operator</td>
                  <td>mo</td><td>err @ {horizon} mo</td>
                </tr>
              </thead>
              <tbody>
                {sortedWells.map((w) => {
                  const e = w[errKey] as number | null;
                  return (
                    <tr key={w.api10} className="acc-selrow" onClick={() => openWell(w.api10)}
                      title="Open well detail">
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{w.api10}</td>
                      <td>{w.tier}</td>
                      <td>{w.formation_blueox}</td>
                      <td className="acc-op">{w.operator ?? "—"}</td>
                      <td className="acc-n">{w.n_months}</td>
                      <td style={{ fontWeight: 600, color: e != null && Math.abs(e) > 0.05 ? accuracyColor(e) : undefined }}>
                        {e == null ? "—" : `${e >= 0 ? "+" : ""}${(e * 100).toFixed(0)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
