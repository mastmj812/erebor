import { useState } from "react";

import { exportSelection } from "../api/export";
import { colorForBlueox } from "../map/formations";
import { useMapStore, type DiscountRate, type SelectionStick } from "../store";

const CAT_ORDER = ["PDP", "PUD", "RES"] as const;
const CAT_LABEL: Record<string, string> = { PDP: "PDP", PUD: "BASE_CASE", RES: "EMERGING" };
const RATES: DiscountRate[] = [5, 10, 15, 20, 25];

function fmtUSD(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}MM`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
const fmtInt = (v: number) => Math.round(v).toLocaleString();

export function ResultsPanel() {
  const sel = useMapStore((s) => s.selection);
  const excluded = useMapStore((s) => s.excludedFormations);
  const toggleFormation = useMapStore((s) => s.toggleFormation);
  const excludedSticks = useMapStore((s) => s.excludedSticks);
  const clearCulls = useMapStore((s) => s.clearCulls);
  const remainingOnly = useMapStore((s) => s.remainingOnly);
  const excludeDepleted = useMapStore((s) => s.excludeDepleted);
  const rate = useMapStore((s) => s.discountRate);
  const setDiscountRate = useMapStore((s) => s.setDiscountRate);
  const metric = useMapStore((s) => s.valueMetric);
  const setValueMetric = useMapStore((s) => s.setValueMetric);
  const aoi = useMapStore((s) => s.aoi);
  const basin = useMapStore((s) => s.basin);
  const rule = useMapStore((s) => s.selectionRule);
  const [exporting, setExporting] = useState(false);
  // null = use the default name; user edits make it sticky for the session.
  const [filenameEdit, setFilenameEdit] = useState<string | null>(null);
  if (!sel) return null;

  const defaultFilename = `erebor_${basin}_${new Date().toISOString().slice(0, 10)}`;
  const filename = filenameEdit ?? defaultFilename;

  const doExport = async () => {
    if (!aoi) return;
    setExporting(true);
    try {
      const byId = new Map(sel.sticks.map((s) => [s.stick_id, s.unique_id]));
      const culledNames = excludedSticks
        .map((id) => byId.get(id))
        .filter((n): n is string => !!n);
      await exportSelection(aoi, basin, rule, culledNames, excluded, filename, remainingOnly, excludeDepleted);
    } catch (e) {
      alert(`Export failed: ${e}`);
    } finally {
      setExporting(false);
    }
  };

  const valKey = `${metric}${rate}` as keyof SelectionStick;
  const exForm = new Set(excluded);
  const exStick = new Set(excludedSticks);

  const cats: Record<string, { count: number; value: number }> = {
    PDP: { count: 0, value: 0 }, PUD: { count: 0, value: 0 }, RES: { count: 0, value: 0 },
  };
  const catForms: Record<string, Map<string, { count: number; value: number }>> = {
    PDP: new Map(), PUD: new Map(), RES: new Map(),
  };
  // Mirror the map's display filters so the value rollup never counts wells you
  // can't see: "Remaining PUDs only" drops anything reconciliation flagged as
  // already realized (keep remaining PUDs + producers/RES with null recon);
  // "Exclude depleted" drops Tier-4 PUDs.
  const passesMapFilter = (s: SelectionStick) =>
    (!remainingOnly || s.recon_status == null || s.recon_status === "remaining_pud") &&
    (!excludeDepleted || s.deplet_t !== "Tier-4");

  let culled = 0;
  let filtered = 0;
  const pads = new Set<string>();
  for (const s of sel.sticks) {
    if (exStick.has(s.stick_id)) { culled++; continue; } // culled -> contributes to nothing
    if (!passesMapFilter(s)) { filtered++; continue; }   // hidden by a map filter
    const v = Number(s[valKey]);
    const fkey = s.formation_blueox ?? "(unmapped)"; // Blue Ox code is the rollup dimension
    const fm = catForms[s.category].get(fkey) ?? { count: 0, value: 0 };
    fm.count++; fm.value += v;
    catForms[s.category].set(fkey, fm);
    if (!exForm.has(fkey)) {
      cats[s.category].count++;
      cats[s.category].value += v;
      if (s.pad_name) pads.add(`${s.category}|${s.pad_name}`);
    }
  }
  const total = cats.PDP.value + cats.PUD.value + cats.RES.value;
  const futureLoc = cats.PUD.count + cats.RES.count;
  const includedCount = cats.PDP.count + cats.PUD.count + cats.RES.count;
  const deck = sel.price_deck;
  const metricLabel = metric.toUpperCase();

  return (
    <div className="panel results">
      <h3>Selection ({sel.rule})</h3>
      <div className="count">
        {includedCount.toLocaleString()} of {sel.count.toLocaleString()} sticks in rollup
        {excluded.length ? ` · ${excluded.length} formation${excluded.length > 1 ? "s" : ""} off` : ""}
        {filtered > 0 ? ` · ${filtered.toLocaleString()} filtered (remaining/depletion)` : ""}
        {sel.truncated ? " · capped 20k" : ""}
      </div>
      {culled > 0 && (
        <div className="count cull-line">
          ✂ {culled} well{culled > 1 ? "s" : ""} culled
          <button className="link" onClick={() => clearCulls()}>clear culls</button>
        </div>
      )}

      <label className="export-name">
        <input
          type="text"
          value={filename}
          onChange={(e) => setFilenameEdit(e.target.value)}
          spellCheck={false}
        />
        <span className="ext">.xlsx</span>
      </label>
      <button className="export-btn" disabled={exporting} onClick={() => void doExport()}>
        {exporting ? "Exporting…" : "⬇ Export workbook (.xlsx)"}
      </button>

      <h3 style={{ marginTop: 8 }}>Value basis</h3>
      <div className="seg">
        <button className={metric === "npv" ? "active" : ""} onClick={() => setValueMetric("npv")}>NPV</button>
        <button className={metric === "pv" ? "active" : ""} onClick={() => setValueMetric("pv")}>PV</button>
      </div>
      <div className="seg">
        {RATES.map((r) => (
          <button key={r} className={rate === r ? "active" : ""} onClick={() => setDiscountRate(r)}>{r}%</button>
        ))}
      </div>

      <h3 style={{ marginTop: 8 }}>{metricLabel}{rate} rollup</h3>
      <table className="val-table">
        <tbody>
          {CAT_ORDER.map((c) => (
            <tr key={c}>
              <td>{CAT_LABEL[c]}</td>
              <td className="num">{fmtInt(cats[c].count)}</td>
              <td className="num">{fmtUSD(cats[c].value)}</td>
            </tr>
          ))}
          <tr className="total">
            <td>Total</td>
            <td className="num">{fmtInt(includedCount)}</td>
            <td className="num">{fmtUSD(total)}</td>
          </tr>
        </tbody>
      </table>
      <div className="count">{fmtInt(futureLoc)} future locations (BASE_CASE + EMERGING) · {pads.size} pads</div>

      <h3 style={{ marginTop: 10 }}>Formations (include / exclude)</h3>
      {CAT_ORDER.map((c) => {
        const rows = [...catForms[c].entries()].sort((a, b) => b[1].count - a[1].count);
        if (!rows.length) return null;
        return (
          <div key={c} className="fcat-block">
            <div className="fcat">{CAT_LABEL[c]}</div>
            <div className="byform">
              {rows.map(([f, v]) => {
                const on = !exForm.has(f);
                return (
                  <label className="item ffilter" key={f} style={{ opacity: on ? 1 : 0.4 }}>
                    <input type="checkbox" checked={on} onChange={() => toggleFormation(f)} />
                    <span className="swatch" style={{ background: colorForBlueox(basin, f) }} />
                    <span className="bf-name">{f}</span>
                    <span className="bf-n">{fmtInt(v.count)}</span>
                    <span className="bf-npv">{fmtUSD(v.value)}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="count">Cull individual wells by clicking markers in the Gunbarrel tab.</div>

      <h3 style={{ marginTop: 10 }}>Assumptions</h3>
      <div className="count">
        Novi flat deck: WTI ${deck.wti_price} (−${deck.wti_diff}) · HH ${deck.hh_price} (−${deck.hh_diff}) · NGL ${deck.ngl_price}
        {deck.distinct_decks > 1 ? ` · ${deck.distinct_decks} decks` : ""}
      </div>
      <div className="caveat">
        Screening number from Novi’s economics on one flat deck — not the authoritative valuation.
        Convention: value PDP at <b>PV</b> (capex sunk), BASE_CASE/EMERGING at <b>NPV</b> (net of drilling
        cost). Run your model on the workbook export.
      </div>
    </div>
  );
}
