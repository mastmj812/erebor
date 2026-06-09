import { HG_GRADIENT_CSS } from "../map/highgradeColors";
import { useMapStore } from "../store";

const METRIC_LABELS: Record<string, string> = {
  npv5: "NPV @ 5%", npv10: "NPV @ 10%", npv15: "NPV @ 15%", npv20: "NPV @ 20%", npv25: "NPV @ 25%",
  pv5: "PV @ 5%", pv10: "PV @ 10%", pv15: "PV @ 15%", pv20: "PV @ 20%", pv25: "PV @ 25%",
  oil_eur: "Oil EUR", gas_eur: "Gas EUR", well_count: "Well count",
};

export function HighgradeLegend() {
  const highgrade = useMapStore((s) => s.highgrade);
  if (!highgrade || highgrade.value_min == null || highgrade.value_max == null) return null;

  const money = highgrade.metric.startsWith("npv") || highgrade.metric.startsWith("pv");
  const label = METRIC_LABELS[highgrade.metric] ?? highgrade.metric;
  const aggLabel =
    highgrade.metric === "well_count" ? ""
    : highgrade.agg === "per_acre" ? " ($/acre)"
    : ` (${highgrade.agg}/pad)`;

  return (
    <div className="panel hg-legend">
      <h3>{label}{aggLabel}</h3>
      <div className="hg-bar" style={{ background: HG_GRADIENT_CSS }} />
      <div className="hg-bar-labels">
        <span>{fmt(highgrade.value_min, money)}</span>
        <span>{fmt(highgrade.value_max, money)}</span>
      </div>
      <div className="count" style={{ margin: "4px 0 0" }}>
        {highgrade.pad_count.toLocaleString()} pads · low → high
      </div>
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
