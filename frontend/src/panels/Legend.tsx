import { useEffect } from "react";

import { DEPLETION_TIERS, RECON_STATUS, blueoxLegend } from "../map/formations";
import { useMapStore } from "../store";

const _fmt = new Intl.NumberFormat("en-US");

export function Legend() {
  const basin = useMapStore((s) => s.basin);
  const colorMode = useMapStore((s) => s.colorMode);
  const reconCounts = useMapStore((s) => s.reconCounts);
  const loadReconCounts = useMapStore((s) => s.loadReconCounts);

  // Pull per-status stick counts when the legend is showing reconciliation
  // status; cleared on basin change, so this refetches per basin.
  useEffect(() => {
    if (colorMode === "status") loadReconCounts();
  }, [colorMode, basin, loadReconCounts]);

  if (colorMode === "status") {
    return (
      <div className="panel legend">
        <h3>Reconciliation (§6)</h3>
        {RECON_STATUS.map((s) => (
          <div className="item" key={s.key}>
            <span className="swatch" style={{ background: s.color }} />
            <span className="legend-label">{s.label}</span>
            {reconCounts && (
              <span className="legend-count">{_fmt.format(reconCounts[s.key] ?? 0)}</span>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (colorMode === "depletion") {
    return (
      <div className="panel legend">
        <h3>Depletion (Novi tier)</h3>
        {DEPLETION_TIERS.map((t) => (
          <div className="item" key={t.key}>
            <span className="swatch" style={{ background: t.color }} />
            {t.label}
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
