import { useEffect } from "react";

import {
  COVERAGE_COLORS,
  EUR_UNIT,
  MAP_COVERAGE_LABELS,
  MAP_COVERAGE_ORDER,
  NOT_COVERED_COLOR,
  NOT_SCREENED,
  PDP_COLOR,
  UNPRICED_COLOR,
  deckLabel,
  econMetricInfo,
  fetchBoxLegend,
} from "../api/boxMap";
import { blueoxLegend } from "../map/formations";
import { HG_HIGH, HG_LOW, HG_MID } from "../map/highgradeColors";
import { useMapStore } from "../store";

const _fmt = new Intl.NumberFormat("en-US");

// Map legend for the BOX-first color modes. Value modes (EUR per ft, econ) load their
// ramp breaks (P5 / P50 / P95 over the basin's forecast-carrying PUDs) from
// /api/box/legend into the store, which MapView paints from — one source for both.
export function Legend() {
  const basin = useMapStore((s) => s.basin);
  const colorMode = useMapStore((s) => s.colorMode);
  const stream = useMapStore((s) => s.eurStream);
  const econ = useMapStore((s) => s.econMetric);
  const deck = useMapStore((s) => s.mapDeck);
  const legend = useMapStore((s) => s.mapLegend);
  const setMapLegend = useMapStore((s) => s.setMapLegend);
  const boxMeta = useMapStore((s) => s.boxMeta);

  useEffect(() => {
    if (colorMode !== "eur" && colorMode !== "econ") return;
    let alive = true;
    const metric = colorMode === "eur" ? `${stream}_eur_ft` : "econ";
    fetchBoxLegend(basin, metric, colorMode === "econ" ? econ : undefined, deck)
      .then((l) => { if (alive) setMapLegend(l); })
      .catch((e) => console.warn("BOX legend failed", e));
    return () => { alive = false; };
  }, [basin, colorMode, stream, econ, deck, setMapLegend]);

  if (colorMode === "bench") {
    return (
      <div className="panel legend">
        <h3>Formation (Blue Ox)</h3>
        {blueoxLegend(basin).map((g) => (
          <div className="legend-group" key={g.group}>
            <div>{g.group}</div>
            {g.codes.map((c) => (
              <div className="item" key={c.code}>
                <span className="swatch" style={{ background: c.color }} />
                {c.code}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (colorMode === "coverage") {
    const counts = boxMeta?.basin_coverage ?? {};
    return (
      <div className="panel legend">
        <h3>BOX coverage (record run{boxMeta ? ` ${boxMeta.run.run_id}` : ""})</h3>
        {MAP_COVERAGE_ORDER.filter((k) => k in counts || k === "covered" || k === "covered_provisional" || k === NOT_SCREENED || k === "bench_not_in_box").map((k) => (
          <div className="item" key={k}>
            <span className="swatch" style={{ background: COVERAGE_COLORS[k] }} />
            <span className="legend-label">{MAP_COVERAGE_LABELS[k] ?? k}</span>
            {k in counts && <span className="legend-count">{_fmt.format(counts[k])}</span>}
          </div>
        ))}
        <div className="item"><span className="swatch" style={{ background: PDP_COLOR }} /><span className="legend-label">PDP (producing context)</span></div>
        <div style={{ fontSize: 11, color: "#71717a", marginTop: 4 }}>
          Counts = the basin&rsquo;s locations in BOX&rsquo;s record run (sticks BOX never screened carry no count).
          Grey classes carry no BOX forecast — never a zero. Classes are BOX&rsquo;s and our reconciliation&rsquo;s, never Novi&rsquo;s tags.
        </div>
      </div>
    );
  }

  const isEcon = colorMode === "econ";
  const info = isEcon ? econMetricInfo(econ) : null;
  const title = isEcon ? `${info!.label} (${info!.unit})` : `BOX ${stream} EUR (${EUR_UNIT[stream]})`;
  const b = legend?.breaks;
  const lowBetter = legend?.better === "low";
  const gradient = `linear-gradient(to right, ${lowBetter ? HG_HIGH : HG_LOW}, ${HG_MID}, ${lowBetter ? HG_LOW : HG_HIGH})`;
  const priced = !isEcon || legend?.priced !== false;
  const deckRow = isEcon ? boxMeta?.decks.find((d) => d.deck_id === legend?.case?.deck_id) : undefined;

  return (
    <div className="panel legend">
      <h3>{title}</h3>
      {!priced ? (
        <div className="caveat">
          Not yet priced on BOX run {legend?.run_id}. Econ shows only for the record run — Steven&rsquo;s
          numbers from another run are never put on these volumes.
        </div>
      ) : legend && legend.n === 0 ? (
        <div className="count">No BOX forecast in this basin — nothing to scale.</div>
      ) : b ? (
        <>
          <div className="hg-bar" style={{ background: gradient }} />
          <div className="hg-bar-labels">
            <span>{fmtV(b.p5)}</span><span>P50 {fmtV(b.p50)}</span><span>{fmtV(b.p95)}</span>
          </div>
          <div className="count" style={{ margin: "4px 0 0" }}>
            P5 → P95 of {_fmt.format(legend!.n)} forecast PUDs ({_fmt.format(legend!.tier_counts?.validated ?? 0)} validated ·{" "}
            {_fmt.format(legend!.tier_counts?.provisional ?? 0)} PROVISIONAL){lowBetter ? " · red = lower (better)" : " · red = higher"}
          </div>
        </>
      ) : (
        <div className="count">loading…</div>
      )}
      <div className="item" style={{ marginTop: 6 }}><span className="swatch" style={{ background: PDP_COLOR }} /><span className="legend-label">PDP (producing context)</span></div>
      {isEcon && <div className="item"><span className="swatch" style={{ background: UNPRICED_COLOR }} /><span className="legend-label">BOX forecast, not priced</span></div>}
      <div className="item"><span className="swatch" style={{ background: NOT_COVERED_COLOR }} /><span className="legend-label">no BOX forecast (hidden unless &ldquo;No BOX forecast&rdquo; is on)</span></div>
      {isEcon && legend?.case && (
        <div style={{ fontSize: 11, color: "#71717a", marginTop: 4 }}>
          Steven&rsquo;s econ, display only (D13): {deckLabel(legend.case.deck_id, deckRow?.wti, deckRow?.hh)} ·
          assumption set {legend.case.assumption_set_id}
          {deckRow?.downtime_basis ? ` · downtime ${deckRow.downtime_basis}` : ""}
          {deckRow?.pushed_at ? ` · pushed ${deckRow.pushed_at.slice(0, 10)}${deckRow.pushed_by ? ` by ${deckRow.pushed_by}` : ""}` : ""}
          {" "}· BOX run {legend.run_id}. erebor computes no economics.
        </div>
      )}
      {!isEcon && (
        <div style={{ fontSize: 11, color: "#71717a", marginTop: 4 }}>
          Raw 50-yr technical EUR ÷ lateral, per foot; includes the bench haircut and the multi-parent oil
          factor (D113). Provisional-tier PUDs are on the same ramp — check the tier in the popup.
        </div>
      )}
    </div>
  );
}

function fmtV(v: number): string {
  const a = Math.abs(v);
  return a >= 100 ? Math.round(v).toLocaleString() : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}
