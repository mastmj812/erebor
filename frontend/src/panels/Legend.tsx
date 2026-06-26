import { RECON_STATUS, blueoxLegend } from "../map/formations";
import { useMapStore } from "../store";

export function Legend() {
  const basin = useMapStore((s) => s.basin);
  const colorMode = useMapStore((s) => s.colorMode);

  if (colorMode === "status") {
    return (
      <div className="panel legend">
        <h3>Reconciliation (§6)</h3>
        {RECON_STATUS.map((s) => (
          <div className="item" key={s.key}>
            <span className="swatch" style={{ background: s.color }} />
            {s.label}
          </div>
        ))}
      </div>
    );
  }

  const groups = blueoxLegend(basin);
  return (
    <div className="panel legend">
      <h3>Formation (Blue Ox)</h3>
      {groups.map((g) => (
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
