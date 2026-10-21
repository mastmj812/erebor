import { useEffect, useState } from "react";

import { MAP_COVERAGE_LABELS } from "../api/boxMap";
import { fetchWellProduction } from "../api/production";
import { fetchLocationWorkup, type LocationWorkup, type WorkupStream } from "../api/workup";
import { useMapStore } from "../store";
import { LineChart, type Series } from "./LineChart";

// Single-location BOX workup (overhaul follow-up, 2026-10-21): how the clicked location's
// record-run forecast was built — the EUR chain, the type curve against its named analogs,
// the cohort's own flags, and what the cohort does NOT show (same-bench producers nearby
// that are not analogs; same-bench BOX neighbours and their per-ft). Backend:
// app/api/workup.py. Display only: nothing here recomputes a forecast.

const STREAMS: WorkupStream[] = ["oil", "gas", "water"];
const DPM = 365.25 / 12;
const FT_PER_MI = 5280;
const FORECAST_COLOR = "#2563eb";
const ANALOG_COLORS = ["#ea580c", "#16a34a", "#9333ea", "#0891b2", "#ca8a04", "#db2777", "#4d7c0f", "#7c2d12", "#0f766e", "#6d28d9"];
const UNIT: Record<WorkupStream, string> = { oil: "bbl", gas: "mcf", water: "bbl" };

const n0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString());
const n1 = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 }));
const n2 = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
const n3 = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(3));
const mi = (ft: number | null | undefined) => (ft == null ? "—" : (ft / FT_PER_MI).toFixed(1));
const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

// Observed months only (an analog's series is None past the data cut-off).
function observed(xs: (number | null)[]): number[] {
  const k = xs.findIndex((v) => v == null);
  return (k < 0 ? xs : xs.slice(0, k)) as number[];
}

function cumsum(xs: number[]): number[] {
  let a = 0;
  return xs.map((v) => (a += v));
}

export function WorkupView() {
  const basin = useMapStore((s) => s.basin);
  const stickId = useMapStore((s) => s.workupStickId);
  const prevId = useMapStore((s) => s.workupPrevId);
  const wk = useMapStore((s) => s.workup);
  const cache = useMapStore((s) => s.workupCache);
  const loading = useMapStore((s) => s.workupLoading);
  const onMap = useMapStore((s) => s.workupOnMap);
  const st = useMapStore;
  const [stream, setStream] = useState<WorkupStream>("oil");
  const [mode, setMode] = useState<"cum" | "rate">("cum");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (stickId == null || st.getState().workupCache[stickId]) return;
    let alive = true;
    st.getState().setWorkupLoading(true);
    setErr(null);
    fetchLocationWorkup(basin, stickId)
      .then((w) => { if (alive) st.getState().setWorkup(w); })
      .catch((e) => { if (alive) { setErr(String(e)); st.getState().setWorkupLoading(false); } });
    return () => { alive = false; };
  }, [basin, stickId, st]);

  // Open another location the way a map click does: its workup + its single-well curve.
  const open = (id: number, name: string, fromNeighbour: boolean) => {
    st.getState().openWorkup(id, fromNeighbour);
    fetchWellProduction(name, basin).then((w) => st.getState().setWellOverlay(w)).catch((e) => console.error(e));
  };

  if (stickId == null) {
    return <div className="count">Click a Novi stick location on the map to see how its BOX forecast was built.</div>;
  }
  if (err) return <div className="caveat">Workup failed: {err}</div>;
  if (!wk || loading) return <div className="count">Loading the BOX workup…</div>;

  const L = wk.location;
  const forecast = L.tier != null;
  const prev = prevId != null ? cache[prevId] : undefined;

  return (
    <div className="box-wu wk">
      <div className="wk-head">
        <strong>{L.unique_id}</strong>
        <span className="count" style={{ margin: 0 }}>
          {" "}· {L.formation_blueox ?? "(unmapped)"} · {L.operator ?? "—"} · lateral {n0(L.lateral_ft ?? L.ll_ft)} ft
          {L.tvd ? ` · TVD ${n0(L.tvd)} ft` : ""} · BOX run {wk.run.run_id} (production through {wk.run.data_through})
        </span>
        {L.tier === "provisional" && <span className="box-prov-badge">PROVISIONAL</span>}
        {L.tier === "validated" && <span className="wk-valid">validated</span>}
        <div className="wk-actions">
          <label><input type="checkbox" checked={onMap} onChange={() => st.getState().setWorkupOnMap(!onMap)} /> cohort on map</label>
          <button className="link" onClick={() => { st.getState().setWorkupOnMap(true); st.getState().zoomToWorkup(); }}>zoom to cohort</button>
          {prev && (
            <button className="link" onClick={() => open(prev.location.stick_id, prev.location.unique_id, true)}>
              ⇄ back to {prev.location.unique_id}
            </button>
          )}
        </div>
      </div>

      {!forecast && (
        <div className="caveat">
          No BOX forecast: {MAP_COVERAGE_LABELS[L.coverage] ?? L.coverage}. Nothing here is valued — never a zero.
        </div>
      )}

      {wk.notes.length > 0 && (
        <>
          <h4>What shapes this number</h4>
          <ul className="wk-notes">{wk.notes.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </>
      )}

      {forecast && <Chain wk={wk} />}
      {forecast && wk.chart && <CurveChart wk={wk} stream={stream} setStream={setStream} mode={mode} setMode={setMode} />}
      {forecast && <Params wk={wk} />}

      <h4>Analog cohort ({wk.analogs.length}{L.n_analogs != null && L.n_analogs !== wk.analogs.length ? ` of ${L.n_analogs}` : ""})
        {L.radius_mi != null ? ` — search ${L.search_mode ?? ""} to ${L.radius_mi} mi (${L.radius_class ?? ""})` : ""}</h4>
      {wk.analogs.length === 0 ? <div className="count">No named analogs.</div> : (
        <table className="box-tbl">
          <thead><tr>
            <th>#</th><th>Well</th><th>Operator</th><th>Bench</th><th className="num">mi</th><th className="num">Lateral ft</th>
            <th>First prod</th><th className="num">Mo</th><th className="num" title="actual cumulative oil, bbl per 1,000 ft, calendar">Oil 12-mo /kft</th>
            <th className="num">Oil 24-mo /kft</th>
          </tr></thead>
          <tbody>
            {wk.analogs.map((a, i) => (
              <tr key={a.api10}>
                <td><span className="swatch" style={{ background: ANALOG_COLORS[i % ANALOG_COLORS.length], width: 8, height: 8 }} /> {a.rank}</td>
                <td title={a.api10}>{a.well_name ?? a.api10}{a.transfer ? " (transfer)" : ""}</td>
                <td>{a.operator ?? "—"}</td><td>{a.formation_blueox ?? "—"}</td>
                <td className="num">{mi(a.dist_ft)}</td><td className="num">{n0(a.lateral_ft)}</td>
                <td>{a.first_production?.slice(0, 7) ?? "—"}</td><td className="num">{a.months_observed ?? "—"}</td>
                <td className="num">{n0(a.oil_cum12_per_kft)}</td><td className="num">{n0(a.oil_cum24_per_kft)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {wk.nearby_pdp.length > 0 && (
        <>
          <h4>Same-bench producers within 2 mi NOT in the cohort</h4>
          <table className="box-tbl">
            <thead><tr><th>Well</th><th>Operator</th><th className="num">mi</th><th className="num">Lateral ft</th><th>First prod</th>
              <th className="num">Mo</th><th className="num">Oil 12-mo /kft</th></tr></thead>
            <tbody>
              {wk.nearby_pdp.map((p) => (
                <tr key={p.api10}>
                  <td title={p.api10}>{p.well_name}</td><td>{p.operator ?? "—"}</td><td className="num">{mi(p.dist_ft)}</td>
                  <td className="num">{n0(p.lateral_ft)}</td><td>{p.first_production?.slice(0, 7) ?? "—"}</td>
                  <td className="num">{p.months_observed ?? "—"}</td><td className="num">{n0(p.oil_cum12_per_kft)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="count">Context only: BOX&rsquo;s analog rules (bench, lateral band, vintage, months on production) decide the cohort.</div>
        </>
      )}

      {wk.neighbours.length > 0 && (
        <>
          <h4>Same-bench BOX locations within 1 mi (click to open; ⇄ steps back)</h4>
          <table className="box-tbl">
            <thead><tr><th>Location</th><th className="num">ft away</th><th>Tier</th><th className="num">Oil bbl/ft</th>
              <th className="num">Analogs</th><th className="num">Radius mi</th><th className="num">Lateral ft</th></tr></thead>
            <tbody>
              {wk.neighbours.map((n) => (
                <tr key={n.stick_id} className="wk-click" onClick={() => open(n.stick_id, n.unique_id, true)}>
                  <td>{n.unique_id}</td><td className="num">{n0(n.dist_ft)}</td>
                  <td>{n.coverage === "covered" ? "validated" : n.coverage === "covered_provisional" ? "PROVISIONAL" : (MAP_COVERAGE_LABELS[n.coverage] ?? n.coverage)}</td>
                  <td className="num">{n1(n.oil_eur_ft)}</td><td className="num">{n.n_analogs ?? "—"}</td>
                  <td className="num">{n.radius_mi ?? "—"}</td><td className="num">{n0(n.lateral_ft)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {wk.proximity && (
        <>
          <h4>PDP proximity</h4>
          <div className="count">
            {wk.proximity.outcome_text}{wk.proximity.factor != null && wk.proximity.factor < 1 ? ` · oil × ${n3(wk.proximity.factor)}` : ""} · {wk.proximity.config_line}
            {wk.proximity.parents.length ? ` · parents: ${wk.proximity.parents.map((p) => `${p.well_name ?? p.api10} (${p.parent_bench}, ${n0(p.dh_ft)} ft hz)`).join("; ")}` : ""}
          </div>
        </>
      )}

      {wk.group && (
        <>
          <h4>Bench group {wk.group.group}: {wk.group.tier === "provisional" ? "PROVISIONAL" : "validated"}</h4>
          <div className="count">
            {wk.group.label}. Haircut: {wk.group.haircut_method?.method ?? "D62 linear cumulative factor"}
            {wk.group.haircut_method?.eur_factor ? ` (median EUR factor oil ${n3(wk.group.haircut_method.eur_factor.oil)}, gas ${n3(wk.group.haircut_method.eur_factor.gas)})` : ""}.
            {wk.group.tier_label ? ` ${wk.group.tier_label}.` : ""}{wk.group.holdout ? ` Holdout: ${wk.group.holdout}.` : ""}
            {wk.group.latest_vintage_text ? ` ${wk.group.latest_vintage_text}` : ""}
          </div>
        </>
      )}
      {(L.flags ?? []).length > 0 && (
        <>
          <h4>The run&rsquo;s flags on this location</h4>
          <ul className="box-flags">{(L.flags ?? []).map((f, i) => <li key={i}>{f}</li>)}</ul>
        </>
      )}
      {wk.water && (
        <div className="count">
          Water: {wk.water.water_source === "measured" ? "WOR fitted on MEASURED-water analogs" : "calculated-water fallback (no measured analogs within 50 mi)"}
          {" "}({wk.water.n_water_analogs} analogs to {wk.water.water_radius_mi ?? "—"} mi{wk.water.water_thin ? ", thin" : ""}); cum-12 WOR {n2(wk.water.water_wor_cum12)}.
          The water cohort differs from the oil / gas analogs above.
        </div>
      )}
      <div className="count" style={{ marginTop: 6 }}>
        Display only: BOX record run {wk.run.run_id}; EUR = raw 50-yr technical integral (no economic limit); volumes uptime-free (D63).
      </div>
    </div>
  );
}

// EUR = cohort P50 per 1,000 ft × lateral multiplier × haircut × proximity — the stored number, reproduced.
function Chain({ wk }: { wk: LocationWorkup }) {
  return (
    <>
      <h4>How the EUR is built</h4>
      <table className="box-tbl">
        <thead><tr>
          <th>Stream</th><th className="num" title="analog cohort P50 EUR per 1,000 ft, before haircut and proximity">Cohort P50 /kft</th>
          <th className="num">× lateral mult</th><th className="num">× haircut</th><th className="num">× proximity</th>
          <th className="num">= EUR</th><th className="num">per ft</th>
        </tr></thead>
        <tbody>
          {STREAMS.map((s) => {
            const c = wk.chain[s];
            if (!c) return null;
            return (
              <tr key={s}>
                <td>{s}{s === "water" && wk.streams.water?.tier === "provisional" ? " (prov.)" : ""}</td>
                <td className="num">{n0(c.cohort_p50_per_kft)} {UNIT[s]}</td>
                <td className="num" title={c.cui_cross ? `Cui & Cross below 7,500 ft (D50); linear would be ${n2(c.linear_mult)}` : "lateral / 1,000"}>
                  {n2(c.lateral_mult)}{c.cui_cross ? " (Cui & Cross)" : ""}
                </td>
                <td className="num">{n3(c.haircut)}</td><td className="num">{n3(c.prox_factor)}</td>
                <td className="num">{n0(c.eur)} {UNIT[s]}{c.check ? "" : " ⚠"}</td>
                <td className="num">{n1(c.eur_per_ft)} {UNIT[s]}/ft</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// The type curve per stream (Arps on the cohort P50, per 1,000 ft). Di stated nominal AND 1-yr effective.
function Params({ wk }: { wk: LocationWorkup }) {
  const flags = (wk.location.flags ?? []).join(" ");
  return (
    <>
      <h4>Type curve (cohort P50, per 1,000 ft)</h4>
      <table className="box-tbl">
        <thead><tr><th>Stream</th><th className="num" title="peak rate per 1,000 ft per day (uptime-free)">qi /d /kft</th>
          <th className="num">Di nominal /yr</th><th className="num">1-yr eff.</th><th className="num">b</th><th className="num">Df</th>
          <th className="num">Peak mo</th><th className="num">12-mo cum /kft</th><th>Model</th></tr></thead>
        <tbody>
          {STREAMS.map((s) => {
            const p = wk.streams[s];
            if (!p || p.qi == null) return null;
            const atBound = new RegExp(`${s} (Di|b) at bound`).test(flags);
            const mult = wk.chain[s]?.lateral_mult; // the stored cum-12 is the location's; per 1,000 ft on the analog basis
            return (
              <tr key={s}>
                <td>{s}{atBound ? " ⚠ at bound" : ""}</td><td className="num">{n1(p.qi)}</td>
                <td className="num">{n2(p.di_nominal)}</td><td className="num">{pct(p.di_eff_1yr)}</td>
                <td className="num">{n3(p.b)}</td><td className="num">{n2(p.df)}</td><td className="num">{p.peak_month ?? "—"}</td>
                <td className="num">{n0(p.cum12 != null && mult ? p.cum12 / mult : null)} {UNIT[s]}</td><td>{p.model_type ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// Forecast per 1,000 ft on the ANALOG basis (volume ÷ lateral multiplier: cohort P50 × haircut ×
// proximity) against each analog's calendar actuals per 1,000 ft and the analogs' P10 / P50 / P90.
function CurveChart({ wk, stream, setStream, mode, setMode }: {
  wk: LocationWorkup; stream: WorkupStream; setStream: (s: WorkupStream) => void;
  mode: "cum" | "rate"; setMode: (m: "cum" | "rate") => void;
}) {
  const ch = wk.chart!;
  const curves: { label: string; color: string; monthly: number[] }[] = stream === "water"
    ? (ch.water_curves ?? []).map((c, i) => ({ label: `measured-water analog ${i + 1}`, color: "#a1a1aa", monthly: observed(c) }))
    : wk.analogs.map((a, i) => ({
        label: `#${a.rank} ${a.well_name ?? a.api10} (${mi(a.dist_ft)} mi, ${n0(a.lateral_ft)} ft)`,
        color: ANALOG_COLORS[i % ANALOG_COLORS.length],
        monthly: observed(a.actual[stream] ?? []),
      }));
  const longest = Math.max(0, ...curves.map((c) => c.monthly.length));
  const kMax = Math.min(ch.months, Math.max(36, longest + 12));
  const toYs = (monthly: number[]) => (mode === "cum" ? cumsum(monthly) : monthly.map((v) => v / DPM));
  const xsOf = (n: number) => Array.from({ length: n }, (_, k) => (mode === "cum" ? k + 1 : k + 0.5));
  const series: Series[] = [];
  for (const c of curves) {
    if (c.monthly.length) series.push({ label: c.label, color: c.color, xs: xsOf(c.monthly.length), ys: toYs(c.monthly), width: 1 });
  }
  const band = ch.band[stream];
  if (band && mode === "cum") {
    for (const [k, lbl] of [["p10", "analog P10 (high)"], ["p50", "analog P50"], ["p90", "analog P90 (low)"]] as const) {
      const ys = observed(band[k].slice(0, kMax));
      if (ys.length) series.push({ label: `${lbl}`, color: k === "p50" ? "#18181b" : "#71717a", xs: xsOf(ys.length), ys, dashed: true, width: k === "p50" ? 1.5 : 1 });
    }
  }
  const f = ch.forecast[stream];
  if (f) series.push({ label: `BOX forecast (run ${wk.run.run_id})`, color: FORECAST_COLOR, xs: xsOf(kMax), ys: toYs(f.slice(0, kMax)), width: 2.5 });
  const unit = ch.unit[stream];

  return (
    <>
      <h4 style={{ display: "flex", gap: 8, alignItems: "center" }}>
        Forecast vs analogs, per 1,000 ft
        <span className="seg sm">
          {STREAMS.map((s) => <button key={s} className={stream === s ? "active" : ""} onClick={() => setStream(s)}>{s}</button>)}
        </span>
        <span className="seg sm">
          <button className={mode === "cum" ? "active" : ""} onClick={() => setMode("cum")}>cum</button>
          <button className={mode === "rate" ? "active" : ""} onClick={() => setMode("rate")}>rate</button>
        </span>
      </h4>
      <LineChart
        series={series} width={620} height={250}
        xlabel="months on production"
        ylabel={mode === "cum" ? `cum (${unit})` : `rate (${unit.replace(" per", "/d per")})`}
      />
      <div className="count">
        Blue = BOX forecast on the analog basis (cohort P50 × haircut × proximity, uptime-free); thin lines = each analog&rsquo;s
        calendar actuals per 1,000 ft of its own lateral (they carry downtime, D63){mode === "cum" ? "; dashed = analog P10 (high) / P50 / P90 (low), months with ≥ 3 analogs" : ""}.
        {stream === "water" ? " Water's analogs are the MEASURED-water cohort (sql/62), not the oil / gas analogs." : ""} Hover a line for its well.
      </div>
    </>
  );
}
