import { useEffect, useMemo, useState } from "react";

import { fetchAccSummary, fetchAccWells, ACC_HORIZONS, type AccSummary } from "../api/accuracy";
import { accuracyColor } from "../map/accuracyColors";
import { colorForBlueox } from "../map/formations";
import { useMapStore, type Phase } from "../store";
import { ChipGroup } from "./ChipGroup";
import { LineChart, type Series } from "./LineChart";

const STREAMS: Phase[] = ["oil", "gas", "water"];

function pct(v: number | null | undefined, signed = true): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = (v * 100).toFixed(1);
  return `${signed && v >= 0 ? "+" : ""}${s}%`;
}

// Left panel of the Accuracy tab: Novi Intelligence forecast vs realized
// actuals over the blind-well population (see backend/app/api/accuracy.py).
export function AccuracyPanel() {
  const basin = useMapStore((s) => s.basin);
  const setBasin = useMapStore((s) => s.setBasin);
  const accWells = useMapStore((s) => s.accWells);
  const summary = useMapStore((s) => s.accSummary);
  const summaryLoading = useMapStore((s) => s.accSummaryLoading);
  const tier = useMapStore((s) => s.accTier);
  const stream = useMapStore((s) => s.accStream);
  const norm = useMapStore((s) => s.accNorm);
  const horizon = useMapStore((s) => s.accHorizon);
  const bench = useMapStore((s) => s.accBench);
  const operator = useMapStore((s) => s.accOperator);
  const setTier = useMapStore((s) => s.setAccTier);
  const setStream = useMapStore((s) => s.setAccStream);
  const setNorm = useMapStore((s) => s.setAccNorm);
  const setHorizon = useMapStore((s) => s.setAccHorizon);
  const toggleBench = useMapStore((s) => s.toggleAccBench);
  const toggleOperator = useMapStore((s) => s.toggleAccOperator);
  const clearFilters = useMapStore((s) => s.clearAccFilters);

  const [error, setError] = useState<string | null>(null);
  const [opSearch, setOpSearch] = useState("");

  // Map layer data: one fetch per basin (all error variants ship at once).
  useEffect(() => {
    if (accWells) return;
    let live = true;
    fetchAccWells(basin)
      .then((r) => { if (live) useMapStore.getState().setAccWells(r.wells); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [basin, accWells]);

  // Summary: refetch on any filter/param change.
  useEffect(() => {
    let live = true;
    useMapStore.getState().setAccSummaryLoading(true);
    setError(null);
    fetchAccSummary({ basin, tier, stream, norm, horizon, bench, operator })
      .then((s) => { if (live) useMapStore.getState().setAccSummary(s); })
      .catch((e) => {
        if (live) { setError(String(e)); useMapStore.getState().setAccSummary(null); }
      });
    return () => { live = false; };
  }, [basin, tier, stream, norm, horizon, bench, operator]);

  // Facet options come from the loaded wells layer (no extra endpoint).
  const { benchOptions, operatorOptions } = useMemo(() => {
    const benches = new Map<string, number>();
    const ops = new Map<string, number>();
    for (const f of accWells?.features ?? []) {
      const p = f.properties as Record<string, unknown> | null;
      if (!p) continue;
      const b = (p.formation_blueox as string) ?? "(unmapped)";
      benches.set(b, (benches.get(b) ?? 0) + 1);
      const o = p.operator as string | null;
      if (o) ops.set(o, (ops.get(o) ?? 0) + 1);
    }
    return {
      benchOptions: [...benches.keys()].sort(),
      operatorOptions: [...ops.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o),
    };
  }, [accWells]);

  const h = summary?.headline;

  return (
    <div className="panel highgrade">
      <div className="seg">
        <button className={basin === "delaware" ? "active" : ""} onClick={() => setBasin("delaware")}>Delaware</button>
        <button className={basin === "midland" ? "active" : ""} onClick={() => setBasin("midland")}>Midland</button>
      </div>
      <div className="count">
        Novi forecast vs actuals on wells the 2025Q3 vintage was blind to.
        Cum-based % error; forecast is P50, so <em>bias</em> (mean error) is the
        calibration number and MAE is dispersion.
      </div>

      <h3>Population</h3>
      <div className="seg sm">
        <button className={tier === "all" ? "active" : ""} onClick={() => setTier("all")}>All</button>
        <button className={tier === "direct" ? "active" : ""} onClick={() => setTier("direct")}>Direct</button>
        <button className={tier === "proxy" ? "active" : ""} onClick={() => setTier("proxy")}>Proxy</button>
      </div>
      <div className="count" style={{ margin: "2px 0 8px" }}>
        {tier === "direct"
          ? "Wells that realized a Novi PUD stick — compared to that stick's own forecast."
          : tier === "proxy"
            ? "Wells with no co-extent stick — compared to the per-ft median of nearby same-bench sticks."
            : "Direct (realized a PUD stick) + proxy (neighborhood-median benchmark)."}
      </div>

      <h3>Stream · basis · horizon</h3>
      <div className="seg sm">
        {STREAMS.map((p) => (
          <button key={p} className={stream === p ? "active" : ""} onClick={() => setStream(p)}>
            {p[0].toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>
      <div className="seg sm" style={{ marginTop: 4 }}>
        <button className={norm === "perft" ? "active" : ""} onClick={() => setNorm("perft")}>per 1,000 ft</button>
        <button
          className={norm === "raw" ? "active" : ""}
          disabled={tier !== "direct"}
          title={tier !== "direct" ? "Raw-volume errors exist only on the direct tier" : undefined}
          onClick={() => setNorm("raw")}
        >raw volumes</button>
      </div>
      <div className="seg sm" style={{ marginTop: 4 }}>
        {ACC_HORIZONS.map((m) => (
          <button key={m} className={horizon === m ? "active" : ""} onClick={() => setHorizon(m)}>{m} mo</button>
        ))}
      </div>

      {error && <div className="caveat" style={{ color: "#991b1b", background: "#fef2f2", borderColor: "#fecaca" }}>{error}</div>}

      {h && (
        <div className="hg-summary">
          <div className="acc-tiles">
            <div className="acc-tile">
              <div className="acc-tile-v" style={{ color: accuracyColor(h.bias_pct) === "#9ca3af" ? undefined : "#111827" }}>{pct(h.bias_pct)}</div>
              <div className="acc-tile-l">bias @ {h.mop} mo</div>
            </div>
            <div className="acc-tile">
              <div className="acc-tile-v">{pct(h.mae_pct, false)}</div>
              <div className="acc-tile-l">MAE</div>
            </div>
            <div className="acc-tile">
              <div className="acc-tile-v">{pct(h.median_pct)}</div>
              <div className="acc-tile-l">median</div>
            </div>
            <div className="acc-tile">
              <div className="acc-tile-v">{h.n.toLocaleString()}</div>
              <div className="acc-tile-l">wells</div>
            </div>
          </div>
          {summary && summary.by_tier.length > 1 && (
            <div className="count" style={{ margin: "4px 0 0" }}>
              {summary.by_tier.map((t) => `${t.tier}: ${pct(t.bias_pct)} (n=${t.n})`).join(" · ")}
            </div>
          )}
          {summary && summary.ll_ratio.mean != null && (
            <div className="count" style={{ margin: "2px 0 0" }}>
              drilled/assumed lateral (direct): ×{summary.ll_ratio.mean.toFixed(2)} mean
              (p10 ×{summary.ll_ratio.p10?.toFixed(2)} · p90 ×{summary.ll_ratio.p90?.toFixed(2)})
            </div>
          )}
        </div>
      )}
      {summaryLoading && !h && <div className="count">Loading summary…</div>}

      {summary && summary.by_month.length > 0 && (
        <>
          <h3 style={{ marginTop: 10 }}>Error by month</h3>
          <BiasByMonth summary={summary} />
          <div className="count" style={{ margin: "2px 0 0" }}>
            months 1–2 muted: partial first calendar month biases actuals low
          </div>
        </>
      )}

      {summary && summary.histogram.counts.some((c) => c > 0) && (
        <>
          <h3 style={{ marginTop: 10 }}>Per-well error @ {horizon} mo</h3>
          <ErrHistogram edges={summary.histogram.bin_edges} counts={summary.histogram.counts} />
        </>
      )}

      {summary && summary.by_bench.length > 0 && (
        <>
          <h3 style={{ marginTop: 10 }}>By bench</h3>
          <table className="acc-table">
            <tbody>
              {summary.by_bench.slice(0, 10).map((b) => (
                <tr key={b.formation_blueox}>
                  <td>{b.formation_blueox}</td>
                  <td style={{ color: (b.bias_pct ?? 0) < -0.1 ? "#b91c1c" : undefined }}>{pct(b.bias_pct)}</td>
                  <td>{pct(b.mae_pct, false)}</td>
                  <td className="acc-n">{b.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {summary && summary.by_operator.length > 0 && (
        <>
          <h3 style={{ marginTop: 10 }}>By operator (top {summary.by_operator.length})</h3>
          <table className="acc-table">
            <tbody>
              {summary.by_operator.map((o) => (
                <tr key={o.operator}>
                  <td className="acc-op">{o.operator}</td>
                  <td style={{ color: (o.bias_pct ?? 0) < -0.1 ? "#b91c1c" : undefined }}>{pct(o.bias_pct)}</td>
                  <td>{pct(o.mae_pct, false)}</td>
                  <td className="acc-n">{o.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 style={{ marginTop: 10 }}>Filters {(bench.length + operator.length > 0 || tier !== "all") && (
        <button className="acc-clear" onClick={clearFilters}>clear</button>
      )}</h3>
      <ChipGroup
        label="Bench (Blue Ox)"
        options={benchOptions}
        selected={bench}
        onToggle={toggleBench}
        swatch={(code) => colorForBlueox(basin, code)}
      />
      <h3>Operator {operator.length > 0 && <span className="hg-n">({operator.length})</span>}</h3>
      <input
        placeholder="Search operators…"
        value={opSearch}
        onChange={(e) => setOpSearch(e.target.value)}
        style={{ width: "100%", fontSize: 12, marginBottom: 4 }}
      />
      <div className="hg-oplist">
        {operatorOptions
          .filter((o) => o.toLowerCase().includes(opSearch.toLowerCase()))
          .slice(0, 60)
          .map((o) => (
            <label key={o} className="hg-oprow">
              <input type="checkbox" checked={operator.includes(o)} onChange={() => toggleOperator(o)} />
              <span>{o}</span>
            </label>
          ))}
      </div>
    </div>
  );
}

// Bias (solid, split so mop 1-2 render light) + MAE (dashed) vs month.
function BiasByMonth({ summary }: { summary: AccSummary }) {
  const rows = summary.by_month;
  const early = rows.filter((r) => r.mop <= 3);
  const late = rows.filter((r) => r.mop >= 3);
  const series: Series[] = [
    {
      label: "bias (early, partial-month bias)", color: "#c4b5fd",
      xs: early.map((r) => r.mop), ys: early.map((r) => (r.bias_pct ?? 0) * 100),
    },
    {
      label: "bias %", color: "#6d28d9", width: 2,
      xs: late.map((r) => r.mop), ys: late.map((r) => (r.bias_pct ?? 0) * 100),
    },
    {
      label: "MAE %", color: "#a1a1aa", dashed: true,
      xs: rows.map((r) => r.mop), ys: rows.map((r) => (r.mae_pct ?? 0) * 100),
    },
  ];
  return <LineChart series={series} width={250} height={170} xlabel="months on production" ylabel="% error" signedY />;
}

function ErrHistogram({ edges, counts }: { edges: number[]; counts: number[] }) {
  const W = 250, H = 90, PAD_B = 14;
  const max = Math.max(1, ...counts);
  const bw = W / counts.length;
  return (
    <svg width={W} height={H} style={{ display: "block" }}>
      {counts.map((c, i) => {
        const mid = (edges[i] + edges[i + 1]) / 2;
        const bh = ((H - PAD_B) * c) / max;
        return (
          <rect key={i} x={i * bw + 0.5} y={H - PAD_B - bh} width={bw - 1} height={bh}
            fill={accuracyColor(mid)}>
            <title>{`${(edges[i] * 100).toFixed(0)}% … ${(edges[i + 1] * 100).toFixed(0)}%: ${c} wells`}</title>
          </rect>
        );
      })}
      <line x1={W / 2} y1={0} x2={W / 2} y2={H - PAD_B} stroke="#71717a" strokeDasharray="2 2" />
      <text x={2} y={H - 2} fontSize={9} fill="#71717a">-100%</text>
      <text x={W / 2} y={H - 2} fontSize={9} fill="#71717a" textAnchor="middle">0</text>
      <text x={W - 2} y={H - 2} fontSize={9} fill="#71717a" textAnchor="end">+100%</text>
    </svg>
  );
}
