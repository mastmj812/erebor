import { deckLabel } from "../api/boxMap";
import { fmtHgValue, hgAggLabel, hgMetricInfo, hgMetricLabel } from "../api/highgrade";
import { HG_UNVALUED, hgGradientCss } from "../map/highgradeColors";
import { useMapStore } from "../store";

export function HighgradeLegend() {
  const highgrade = useMapStore((s) => s.highgrade);
  if (!highgrade) return null;
  const unvalued = highgrade.pads_unvalued;
  if ((highgrade.value_min == null || highgrade.value_max == null) && unvalued === 0) return null;
  const lowIsBetter = hgMetricInfo(highgrade.metric)?.lowIsBetter ?? false;
  const f = (v: number) => fmtHgValue(v, highgrade.metric, highgrade.agg, true);

  return (
    <div className="panel hg-legend">
      <h3>BOX {hgMetricLabel(highgrade.metric)} ({hgAggLabel(highgrade.agg)})</h3>
      {highgrade.econ && (
        <div className="count" style={{ margin: "0 0 4px" }}>
          Steven, {deckLabel(highgrade.econ.deck_id, highgrade.econ.wti, highgrade.econ.hh)} — display only
        </div>
      )}
      {highgrade.value_min != null && highgrade.value_max != null && (
        <>
          <div className="hg-bar" style={{ background: hgGradientCss(lowIsBetter) }} />
          <div className="hg-bar-labels">
            <span>{f(highgrade.value_min)}</span>
            <span>{f(highgrade.value_max)}</span>
          </div>
        </>
      )}
      <div className="count" style={{ margin: "4px 0 0" }}>
        {(highgrade.pad_count - unvalued).toLocaleString()} pads · red = better{lowIsBetter ? " (lower)" : ""}
      </div>
      {unvalued > 0 && (
        <div className="count" style={{ margin: "4px 0 0", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 10, background: HG_UNVALUED, border: "1px solid #94a3b8", display: "inline-block" }} />
          {unvalued.toLocaleString()} pads {highgrade.econ ? "with no priced location" : "with no BOX forecast"}
        </div>
      )}
    </div>
  );
}
