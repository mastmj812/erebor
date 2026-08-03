import { useEffect, useRef, useState } from "react";

import { fetchAccWell, type AccGunbarrelWell, type AccStreamSeries } from "../api/accuracy";
import { accuracyColor } from "../map/accuracyColors";
import { useMapStore, type GunbarrelPad, type GunbarrelWell, type Phase } from "../store";
import { PadChart } from "./GunbarrelView";
import { LineChart, type Series } from "./LineChart";

const NO_EXFORM = new Set<string>();
const NOVI_RED = "#c0392b"; // forecast color, matching the suite's Novi convention
const ACTUAL_INK = "#111827";
const COMPARISON_BLUE = "#2563eb";
const STREAMS: Phase[] = ["oil", "gas", "water"];
const UNITS: Record<Phase, string> = { oil: "bbl", gas: "Mcf", water: "bbl" };

// Adapt the accuracy neighborhood wells to PadChart's GunbarrelWell contract.
// PDP context rows have no stick_id — synthesize a stable negative key from
// the api10 (the erebor_locations convention).
function toPadChart(api10: string, wells: AccGunbarrelWell[]): {
  pad: GunbarrelPad; role: Map<number, AccGunbarrelWell["role"]>;
} {
  const role = new Map<number, AccGunbarrelWell["role"]>();
  const mapped: GunbarrelWell[] = wells.map((w) => {
    const id = w.stick_id ?? -Number(w.api10 ?? 0);
    role.set(id, w.role);
    return {
      stick_id: id,
      unique_id: w.api10 ?? `stick ${w.stick_id}`,
      category: w.category,
      formation: w.formation_blueox ?? "",
      formation_blueox: w.formation_blueox,
      basin_blueox: null,
      formation_blueox_source: null,
      recon_status: null,
      deplet_t: null,
      pdp_count_3mi: null,
      tvd: w.tvd,
      ll_ft: w.ll_ft,
      offset_ft: w.offset_ft,
    };
  });
  return {
    pad: { pad_name: `${api10} neighborhood (1 mi)`, well_count: mapped.length, wells: mapped },
    role,
  };
}

function seriesFor(
  s: AccStreamSeries, mop: number[], perft: boolean,
): { cum: Series[]; err: Series[] } {
  const pick = (arr: (number | null)[]): [number[], number[]] => {
    const xs: number[] = [], ys: number[] = [];
    arr.forEach((v, i) => { if (v != null) { xs.push(mop[i]); ys.push(v); } });
    return [xs, ys];
  };
  const [fx, fy] = pick(perft ? s.fcst_cum_perft : s.fcst_cum);
  const [ax, ay] = pick(perft ? s.actual_cum_perft : s.actual_cum);
  const [ex, ey] = pick(perft ? s.pct_err_perft : s.pct_err);
  return {
    cum: [
      { label: "actual", color: ACTUAL_INK, width: 2, xs: ax, ys: ay },
      { label: "Novi forecast (P50)", color: NOVI_RED, dashed: true, width: 1.8, xs: fx, ys: fy },
    ],
    err: [
      { label: "% error (cum)", color: "#6d28d9", width: 2, xs: ex, ys: ey.map((v) => v * 100) },
    ],
  };
}

// Click a well on the Accuracy map -> this draggable window: neighborhood
// gunbarrel (subject black, comparison sticks blue, context muted), the
// forecast-vs-actual cum overlay, and the error-over-time chart.
export function AccuracyWellModal() {
  const api10 = useMapStore((s) => s.accWellApi10);
  const data = useMapStore((s) => s.accWell);
  const loading = useMapStore((s) => s.accWellLoading);
  const close = useMapStore((s) => s.closeAccWell);
  const panelStream = useMapStore((s) => s.accStream);

  const [stream, setStream] = useState<Phase>(panelStream);
  const [perft, setPerft] = useState(true);
  const [pos, setPos] = useState(() => ({
    x: Math.max(20, Math.round(window.innerWidth * 0.5 - 380)),
    y: Math.max(40, Math.round(window.innerHeight * 0.5 - 320)),
  }));
  const [dragging, setDragging] = useState(false);
  const offset = useRef({ dx: 0, dy: 0 });

  // Fetch on well change; sync the stream toggle to the panel's selection.
  useEffect(() => {
    if (!api10) return;
    setStream(useMapStore.getState().accStream);
    let live = true;
    fetchAccWell(api10)
      .then((d) => {
        if (!live) return;
        useMapStore.getState().setAccWell(d);
        if (d.tier === "proxy") setPerft(true); // raw undefined on proxy
      })
      .catch((e) => {
        console.error("accuracy well failed", e);
        if (live) useMapStore.getState().closeAccWell();
      });
    return () => { live = false; };
  }, [api10]);

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
    if (!api10) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api10, close]);

  if (!api10) return null;

  const onHeadDown = (e: React.MouseEvent) => {
    offset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    setDragging(true);
    e.preventDefault();
  };

  const isDirect = data?.tier === "direct";
  const usePerft = perft || !isDirect;
  const gb = data ? toPadChart(data.api10, data.gunbarrel.wells) : null;
  const ss = data ? seriesFor(data.series[stream], data.series.mop, usePerft) : null;
  const unit = `${UNITS[stream]}${usePerft ? "/ft" : ""}`;
  const horizon = useMapStore.getState().accHorizon;
  const errNow = data
    ? (usePerft
        ? data.series[stream].pct_err_perft
        : data.series[stream].pct_err)[data.series.mop.indexOf(horizon)] ?? null
    : null;

  return (
    <div className="floatwin acc-win" style={{ left: pos.x, top: pos.y }}>
      <div className="win-head" onMouseDown={onHeadDown}>
        <span className="win-title">
          ⠿ {api10}
          {data && <span className={`acc-badge acc-badge-${data.tier}`}>{data.tier}</span>}
          {data?.low_n && <span className="acc-badge acc-badge-warn">thin benchmark (n={data.n_rep})</span>}
          {data && (data.n_sticks_for_well ?? 0) > 1 && (
            <span className="acc-badge acc-badge-warn">realizes {data.n_sticks_for_well} planned sticks</span>
          )}
        </span>
        <button className="hg-gb-close" aria-label="Close"
          onMouseDown={(e) => e.stopPropagation()} onClick={close}>×</button>
      </div>
      <div className="win-body">
        {loading && <div className="count">Loading well…</div>}
        {data && (
          <>
            <div className="count" style={{ marginBottom: 6 }}>
              {data.operator ?? "—"} · {data.formation_blueox ?? "(unmapped)"} · first prod {data.first_prod}
              {data.pad_name ? ` · pad ${data.pad_name}` : ""}
              <br />
              drilled {fmtFt(data.drilled_ll_ft)}
              {isDirect
                ? <> · Novi assumed {fmtFt(data.novi_ll_ft)}{data.ll_ratio != null && <> (×{data.ll_ratio.toFixed(2)})</>}
                    {data.match_overlap != null && <> · overlap {(data.match_overlap * 100).toFixed(0)}%</>}</>
                : <> · benchmark: median of {data.n_rep} rep sticks (median LL {fmtFt(data.rep_median_ll_ft)})</>}
              {errNow != null && (
                <> · err @ {horizon} mo:{" "}
                  <strong style={{ color: accuracyColor(errNow) }}>
                    {errNow >= 0 ? "+" : ""}{(errNow * 100).toFixed(0)}%
                  </strong>
                </>
              )}
            </div>

            <div className="seg sm" style={{ marginBottom: 4 }}>
              {STREAMS.map((p) => (
                <button key={p} className={stream === p ? "active" : ""} onClick={() => setStream(p)}>
                  {p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
              <span style={{ width: 10 }} />
              <button className={usePerft ? "active" : ""} onClick={() => setPerft(true)}>per ft</button>
              <button
                className={!usePerft ? "active" : ""} disabled={!isDirect}
                title={!isDirect ? "Raw volumes undefined on the proxy tier" : undefined}
                onClick={() => setPerft(false)}
              >raw</button>
            </div>

            {ss && (
              <div className="acc-charts">
                <LineChart series={ss.cum} width={340} height={220}
                  xlabel="months on production" ylabel={`cum ${stream} (${unit})`} />
                <LineChart series={ss.err} width={340} height={220} signedY
                  xlabel="months on production" ylabel="% error (actual vs fcst)" />
              </div>
            )}
            <div className="count" style={{ margin: "0 0 8px" }}>
              solid = actual · dashed = Novi P50 {isDirect ? "(matched stick)" : `(median of ${data.n_rep} rep sticks, per ft)`}
              · months 1–2 and the latest reported month can read low (partial months)
            </div>

            {gb && gb.pad.wells.length > 0 && (
              <>
                <PadChart pad={gb.pad} exForm={NO_EXFORM}
                  isMuted={(w) => gb.role.get(w.stick_id) === "context"}
                  colorOf={(w) => {
                    const r = gb.role.get(w.stick_id);
                    return r === "subject" ? ACTUAL_INK : r === "comparison" ? COMPARISON_BLUE : "#9ca3af";
                  }}
                  width={700} height={260} />
                <div className="count">
                  ● black = this well · {isDirect ? "blue = its matched Novi stick(s)" : "blue = its benchmark rep sticks"} · grey = context (1-mi radius, PDP solid / PUD-RES hollow)
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function fmtFt(v: number | null): string {
  return v == null ? "— ft" : `${Math.round(v).toLocaleString()} ft`;
}
