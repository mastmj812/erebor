import { colorForFormation } from "../map/formations";
import { useMapStore, type DiscountRate, type SelectionGroup } from "../store";

const CAT_ORDER = ["PDP", "PUD", "RES"] as const;
const CAT_LABEL: Record<string, string> = { PDP: "PDP", PUD: "PUD", RES: "RESOURCE" };
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
  const rate = useMapStore((s) => s.discountRate);
  const setDiscountRate = useMapStore((s) => s.setDiscountRate);
  const metric = useMapStore((s) => s.valueMetric);
  const setValueMetric = useMapStore((s) => s.setValueMetric);
  if (!sel) return null;

  const key = `${metric}${rate}` as keyof SelectionGroup;
  const exSet = new Set(excluded);
  const cats: Record<string, { count: number; value: number }> = {
    PDP: { count: 0, value: 0 }, PUD: { count: 0, value: 0 }, RES: { count: 0, value: 0 },
  };
  // Formations per category, for the split checklist.
  const catForms: Record<string, Map<string, { count: number; value: number }>> = {
    PDP: new Map(), PUD: new Map(), RES: new Map(),
  };
  for (const g of sel.groups) {
    const v = Number(g[key]);
    catForms[g.category].set(g.formation, { count: g.count, value: v });
    if (!exSet.has(g.formation)) {
      cats[g.category].count += g.count;
      cats[g.category].value += v;
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
        {includedCount.toLocaleString()} of {sel.count.toLocaleString()} sticks
        {excluded.length ? ` · ${excluded.length} formation${excluded.length > 1 ? "s" : ""} excluded` : ""}
        {sel.truncated ? " · capped 20k" : ""}
      </div>

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
      <div className="count" style={{ marginTop: 2 }}>
        {metric === "npv" ? "NPV = value net of well cost" : "PV = value before well cost"}, discounted {rate}%/yr
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
      <div className="count">{fmtInt(futureLoc)} future locations (PUD + RESOURCE)</div>

      <h3 style={{ marginTop: 10 }}>Formations (include / exclude)</h3>
      {CAT_ORDER.map((c) => {
        const rows = [...catForms[c].entries()].sort((a, b) => b[1].count - a[1].count);
        if (!rows.length) return null;
        return (
          <div key={c} className="fcat-block">
            <div className="fcat">{CAT_LABEL[c]}</div>
            <div className="byform">
              {rows.map(([f, v]) => {
                const on = !exSet.has(f);
                return (
                  <label className="item ffilter" key={f} style={{ opacity: on ? 1 : 0.4 }}>
                    <input type="checkbox" checked={on} onChange={() => toggleFormation(f)} />
                    <span className="swatch" style={{ background: colorForFormation(f) }} />
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
      <div className="count">Excluding a formation drops it from every bucket (depth limit).</div>

      <h3 style={{ marginTop: 10 }}>Assumptions</h3>
      <div className="count">
        Novi flat deck: WTI ${deck.wti_price} (−${deck.wti_diff}) · HH ${deck.hh_price} (−${deck.hh_diff}) · NGL ${deck.ngl_price}
        {deck.distinct_decks > 1 ? ` · ${deck.distinct_decks} decks` : ""}
      </div>
      <div className="caveat">
        Screening number from Novi’s economics on one flat deck — not the authoritative valuation.
        Convention: value PDP at <b>PV</b> (capex sunk), PUD/RESOURCE at <b>NPV</b> (net of drilling
        cost). Run your model on the Phase-5 export.
      </div>
    </div>
  );
}
