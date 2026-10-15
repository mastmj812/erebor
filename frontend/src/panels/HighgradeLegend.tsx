import { isMoneyMetric } from "../api/highgrade";
import { HG_GRADIENT_CSS, HG_UNVALUED } from "../map/highgradeColors";
import { useMapStore } from "../store";
import { METRICS } from "./HighgradePanel";

export function HighgradeLegend() {
  const highgrade = useMapStore((s) => s.highgrade);
  if (!highgrade) return null;
  const box = highgrade.source === "box";
  const unvalued = box ? highgrade.pads_unvalued ?? 0 : 0;
  if ((highgrade.value_min == null || highgrade.value_max == null) && unvalued === 0) return null;

  const money = isMoneyMetric(highgrade.metric);
  const label = `${box ? "BOX " : ""}${METRICS.find((m) => m.value === highgrade.metric)?.label ?? highgrade.metric}`;
  const aggLabel =
    highgrade.metric === "well_count" ? ""
    : highgrade.metric.endsWith("_per_kft") ? " (lateral-weighted/pad)"
    : highgrade.agg === "per_acre" ? " ($/acre)"
    : ` (${highgrade.agg}/pad)`;

  return (
    <div className="panel hg-legend">
      <h3>{label}{aggLabel}</h3>
      {highgrade.value_min != null && highgrade.value_max != null && (
        <>
          <div className="hg-bar" style={{ background: HG_GRADIENT_CSS }} />
          <div className="hg-bar-labels">
            <span>{fmt(highgrade.value_min, money)}</span>
            <span>{fmt(highgrade.value_max, money)}</span>
          </div>
        </>
      )}
      <div className="count" style={{ margin: "4px 0 0" }}>
        {(highgrade.pad_count - unvalued).toLocaleString()} pads · low → high
      </div>
      {unvalued > 0 && (
        <div className="count" style={{ margin: "4px 0 0", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 10, background: HG_UNVALUED, border: "1px solid #94a3b8", display: "inline-block" }} />
          {unvalued.toLocaleString()} pads {highgrade.metric.startsWith("box_pv") ? "with no priced PUD" : "not covered by BOX"}
        </div>
      )}
    </div>
  );
}

function fmt(v: number, money: boolean): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const short =
    abs >= 1e6 ? `${(v / 1e6).toFixed(1)}M` :
    abs >= 1e3 ? `${(v / 1e3).toFixed(0)}k` :
    Math.round(v).toLocaleString();
  return money ? `$${short}` : short;
}
