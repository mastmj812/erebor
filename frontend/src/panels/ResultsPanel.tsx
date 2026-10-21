import { useEffect } from "react";

import {
  ECON_METRICS,
  MAP_COVERAGE_LABELS,
  TIER_OF_COVERAGE,
  deckLabel,
  econMetricInfo,
  type EconMetric,
} from "../api/boxMap";
import { selectByPolygon } from "../api/select";
import { colorForBlueox } from "../map/formations";
import { activeRanges, stickPasses } from "../map/screen";
import { useMapStore, type SelectionStick } from "../store";

// AOI rollup on the BOX record run (overhaul step 4). Per bench: forecast-carrying
// locations (validated / PROVISIONAL), EUR totals, lateral-weighted EUR per ft, and
// Steven's econ for the chosen deck — summed (PV, capex) or as a median (IRR, breakeven),
// display only (D13): erebor computes no economics. Locations without a BOX forecast are
// counted by class, never valued. Novi supplies only geometry: no Novi tags or values here.

type BenchRow = {
  bench: string; n: number; nV: number; nP: number;
  oil: number; gas: number; water: number; latKft: number; oilForFt: number;
  econ: number[]; unpriced: number;
};

const fmt = (v: number, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const isSummed = (m: EconMetric) => m.startsWith("pv") || m === "capex";

export function ResultsPanel() {
  const sel = useMapStore((s) => s.selection);
  const aoi = useMapStore((s) => s.aoi);
  const rule = useMapStore((s) => s.selectionRule);
  const basin = useMapStore((s) => s.basin);
  const excluded = useMapStore((s) => s.excludedFormations);
  const formationFilter = useMapStore((s) => s.formationFilter);
  const toggleFormation = useMapStore((s) => s.toggleFormation);
  const excludedSticks = useMapStore((s) => s.excludedSticks);
  const clearCulls = useMapStore((s) => s.clearCulls);
  const tierFilter = useMapStore((s) => s.tierFilter);
  const proxFilter = useMapStore((s) => s.proxFilter);
  const mapRanges = useMapStore((s) => s.mapRanges);
  const econMetric = useMapStore((s) => s.econMetric);
  const setEconMetric = useMapStore((s) => s.setEconMetric);
  const mapDeck = useMapStore((s) => s.mapDeck);
  const setMapDeck = useMapStore((s) => s.setMapDeck);
  const boxMeta = useMapStore((s) => s.boxMeta);
  const replaceSelectionData = useMapStore((s) => s.replaceSelectionData);

  // The selection carries econ for ONE deck; a deck change re-fetches the same AOI (culls kept).
  const wantDeck = mapDeck ?? boxMeta?.default_deck ?? null;
  useEffect(() => {
    if (!sel || !aoi || !sel.econ || !wantDeck || sel.econ.deck_id === wantDeck) return;
    let alive = true;
    selectByPolygon(aoi, basin, rule, wantDeck)
      .then((r) => { if (alive) replaceSelectionData(r); })
      .catch((e) => console.error("re-select for deck failed", e));
    return () => { alive = false; };
  }, [sel, aoi, basin, rule, wantDeck, replaceSelectionData]);

  if (!sel) return null;

  const exForm = new Set(excluded);
  const exStick = new Set(excludedSticks);
  const formInc = new Set(formationFilter);
  const econKey = `econ_${econMetric}` as keyof SelectionStick;
  const info = econMetricInfo(econMetric);
  const priced = sel.econ != null;

  let culled = 0, pdp = 0, filtered = 0;
  const notCovered: Record<string, number> = {};
  const rows = new Map<string, BenchRow>();
  for (const s of sel.sticks) {
    if (exStick.has(s.stick_id)) { culled++; continue; }
    const bench = s.formation_blueox ?? "(unmapped)";
    if (formInc.size && !formInc.has(bench)) { filtered++; continue; }
    if (s.kind === "PDP") { pdp++; continue; }
    const tier = s.coverage ? TIER_OF_COVERAGE[s.coverage] : undefined;
    if (!tier) {
      const k = s.coverage ?? "not_screened";
      notCovered[k] = (notCovered[k] ?? 0) + 1;
      continue;
    }
    // the map's screen (tier / proximity / every range), one definition: map/screen.ts
    if (!stickPasses(s, { tiers: tierFilter, prox: proxFilter, ranges: mapRanges })) { filtered++; continue; }
    const r = rows.get(bench) ?? { bench, n: 0, nV: 0, nP: 0, oil: 0, gas: 0, water: 0, latKft: 0, oilForFt: 0, econ: [], unpriced: 0 };
    r.n++;
    if (tier === "validated") r.nV++; else r.nP++;
    r.oil += s.oil_eur ?? 0;
    r.gas += s.gas_eur ?? 0;
    r.water += s.water_eur ?? 0;
    if (s.lat_basis_kft && s.oil_eur != null) { r.latKft += s.lat_basis_kft; r.oilForFt += s.oil_eur; }
    const ev = s[econKey];
    if (typeof ev === "number") r.econ.push(ev); else if (priced) r.unpriced++;
    rows.set(bench, r);
  }
  const list = [...rows.values()].sort((a, b) => b.n - a.n);
  const inc = list.filter((r) => !exForm.has(r.bench));
  const tot = inc.reduce((t, r) => ({
    n: t.n + r.n, nV: t.nV + r.nV, nP: t.nP + r.nP, oil: t.oil + r.oil, gas: t.gas + r.gas, water: t.water + r.water,
    latKft: t.latKft + r.latKft, oilForFt: t.oilForFt + r.oilForFt, econ: t.econ.concat(r.econ), unpriced: t.unpriced + r.unpriced,
  }), { n: 0, nV: 0, nP: 0, oil: 0, gas: 0, water: 0, latKft: 0, oilForFt: 0, econ: [] as number[], unpriced: 0 });
  const econCell = (xs: number[]) => {
    if (!priced || !xs.length) return "—";
    return fmt(isSummed(econMetric) ? xs.reduce((a, b) => a + b, 0) : median(xs)!, 1);
  };
  const perFt = (oil: number, lat: number) => (lat > 0 ? fmt(oil / (lat * 1000), 1) : "—");
  const ncTotal = Object.values(notCovered).reduce((a, b) => a + b, 0);
  const decks = [...new Map((boxMeta?.decks ?? []).map((d) => [d.deck_id, d])).values()];

  return (
    <div className="panel results">
      <h3>Selection ({sel.rule}) · BOX run {sel.box_run.run_id}</h3>
      <div className="count">
        {fmt(tot.n)} BOX forecast locations ({fmt(tot.nV)} validated · {fmt(tot.nP)} PROVISIONAL) · {fmt(pdp)} PDP
        {filtered > 0 ? ` · ${fmt(filtered)} filtered (bench / tier / proximity${activeRanges(mapRanges).length ? " / ranges" : ""})` : ""}
        {sel.truncated ? " · capped 20k" : ""}
      </div>
      {culled > 0 && (
        <div className="count cull-line">
          ✂ {culled} culled
          <button className="link" onClick={() => clearCulls()}>clear culls</button>
        </div>
      )}
      {ncTotal > 0 && (
        <div className="count">
          No BOX forecast (counted, never valued): {fmt(ncTotal)} —{" "}
          {Object.entries(notCovered).sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${fmt(n)} ${MAP_COVERAGE_LABELS[k] ?? k}`).join(" · ")}
        </div>
      )}

      <h3 style={{ marginTop: 8 }}>By bench (include / exclude)</h3>
      <table className="val-table bench-table">
        <thead>
          <tr>
            <th />
            <th>Bench</th>
            <th className="num">Locs</th>
            <th className="num" title="oil EUR, MMbbl (raw 50-yr technical)">Oil MMbbl</th>
            <th className="num" title="lateral-weighted oil EUR per foot">bbl/ft</th>
            <th className="num" title="gas EUR, Bcf">Gas Bcf</th>
            <th className="num" title={`${info.label} — ${isSummed(econMetric) ? "sum" : "median"}, ${info.unit}`}>
              {info.label.split(" ")[0]}{isSummed(econMetric) ? "" : " median"}
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => {
            const on = !exForm.has(r.bench);
            return (
              <tr key={r.bench} style={{ opacity: on ? 1 : 0.4 }}>
                <td><input type="checkbox" checked={on} onChange={() => toggleFormation(r.bench)} /></td>
                <td>
                  <span className="swatch" style={{ background: colorForBlueox(basin, r.bench), width: 8, height: 8, marginRight: 4 }} />
                  {r.bench}{r.nP > 0 && r.nV === 0 ? <span className="prov-mark" title="PROVISIONAL tier (D105)"> P</span> : null}
                </td>
                <td className="num" title={`${r.nV} validated · ${r.nP} provisional`}>{fmt(r.n)}</td>
                <td className="num">{fmt(r.oil / 1e6, 2)}</td>
                <td className="num">{perFt(r.oilForFt, r.latKft)}</td>
                <td className="num">{fmt(r.gas / 1e6, 2)}</td>
                <td className="num">{econCell(r.econ)}</td>
              </tr>
            );
          })}
          <tr className="total">
            <td />
            <td>Total</td>
            <td className="num">{fmt(tot.n)}</td>
            <td className="num">{fmt(tot.oil / 1e6, 2)}</td>
            <td className="num">{perFt(tot.oilForFt, tot.latKft)}</td>
            <td className="num">{fmt(tot.gas / 1e6, 2)}</td>
            <td className="num">{econCell(tot.econ)}</td>
          </tr>
        </tbody>
      </table>
      <div className="count">
        Water {fmt(tot.water / 1e6, 2)} MMbbl. P = PROVISIONAL bench (D105). EUR = raw 50-yr technical integral incl. the
        bench haircut and the multi-parent oil factor (D113); per-ft is lateral-weighted.
      </div>

      <h3 style={{ marginTop: 8 }}>Econ (Steven, display only)</h3>
      <div className="row">
        <select value={econMetric} onChange={(e) => setEconMetric(e.target.value as EconMetric)} style={{ flex: 1, fontSize: 12 }}>
          {ECON_METRICS.map((m) => <option key={m.value} value={m.value}>{m.label} ({m.unit})</option>)}
        </select>
        <select value={wantDeck ?? ""} onChange={(e) => setMapDeck(e.target.value || null)} disabled={!priced}
          style={{ flex: 1, fontSize: 12 }}>
          {decks.map((d) => <option key={d.deck_id} value={d.deck_id}>{deckLabel(d.deck_id, d.wti, d.hh)}</option>)}
        </select>
      </div>
      {priced ? (
        <div className="count">
          {info.label}: {isSummed(econMetric) ? "sum" : "median"} over priced locations, {info.unit}
          {tot.unpriced > 0 ? ` · ${fmt(tot.unpriced)} forecast locations unpriced` : ""}.
          {" "}{deckLabel(sel.econ!.deck_id, sel.econ!.wti, sel.econ!.hh)} · assumption set {sel.econ!.assumption_set_id}
          {sel.econ!.downtime_basis ? ` · downtime ${sel.econ!.downtime_basis}` : ""}
          {sel.econ!.pushed_at ? ` · pushed ${sel.econ!.pushed_at.slice(0, 10)}${sel.econ!.pushed_by ? ` by ${sel.econ!.pushed_by}` : ""}` : ""}.
        </div>
      ) : (
        <div className="caveat">Not yet priced on BOX run {sel.box_run.run_id} — econ appears when Steven pushes it.</div>
      )}
      <div className="caveat">
        Econ is Steven&rsquo;s (box_econ), shown as a screen with its provenance — erebor computes no economics (D13).
        BOX run {sel.box_run.run_id}, production through {sel.box_run.data_through}.
      </div>
    </div>
  );
}
