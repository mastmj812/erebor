import { ACC_GRADIENT_CSS, ACC_NULL_GREY } from "../map/accuracyColors";
import { useMapStore } from "../store";

export function AccuracyLegend() {
  const stream = useMapStore((s) => s.accStream);
  const norm = useMapStore((s) => s.accNorm);
  const horizon = useMapStore((s) => s.accHorizon);
  const accWells = useMapStore((s) => s.accWells);

  return (
    <div className="panel hg-legend">
      <h3>
        {stream[0].toUpperCase() + stream.slice(1)} cum error @ {horizon} mo
        {norm === "perft" ? " (per ft)" : " (raw)"}
      </h3>
      <div className="hg-bar" style={{ background: ACC_GRADIENT_CSS }} />
      <div className="hg-bar-labels">
        <span>−50% under</span>
        <span>on fcst</span>
        <span>+50% over</span>
      </div>
      <div className="count" style={{ margin: "4px 0 0", display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 10, height: 10, background: ACC_NULL_GREY, borderRadius: 2, display: "inline-block" }} />
        insufficient history / no benchmark
      </div>
      {accWells && (
        <div className="count" style={{ margin: "2px 0 0" }}>
          {accWells.features.length.toLocaleString()} blind wells · click one for detail
        </div>
      )}
    </div>
  );
}
