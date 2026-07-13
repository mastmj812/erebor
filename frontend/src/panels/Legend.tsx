import { useEffect } from "react";

import { DEPLETION_TIERS, RECON_STATUS, SUPPORT_TIERS, blueoxLegend } from "../map/formations";
import { useMapStore } from "../store";

const _fmt = new Intl.NumberFormat("en-US");

export function Legend() {
  const basin = useMapStore((s) => s.basin);
  const colorMode = useMapStore((s) => s.colorMode);
  const reconCounts = useMapStore((s) => s.reconCounts);
  const loadReconCounts = useMapStore((s) => s.loadReconCounts);
  const depletionCounts = useMapStore((s) => s.depletionCounts);
  const loadDepletionCounts = useMapStore((s) => s.loadDepletionCounts);
  const supportCounts = useMapStore((s) => s.supportCounts);
  const loadSupportCounts = useMapStore((s) => s.loadSupportCounts);

  // Pull per-status / per-tier / per-support-bucket stick counts for whichever
  // color mode is active; all are cleared on basin change, so these refetch per basin.
  useEffect(() => {
    if (colorMode === "status") loadReconCounts();
    if (colorMode === "depletion") loadDepletionCounts();
    if (colorMode === "support") loadSupportCounts();
  }, [colorMode, basin, loadReconCounts, loadDepletionCounts, loadSupportCounts]);

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
            <span className="legend-label">{t.label}</span>
            {depletionCounts && (
              <span className="legend-count">{_fmt.format(depletionCounts[t.key] ?? 0)}</span>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (colorMode === "support") {
    return (
      <div className="panel legend">
        <h3>PDP support (3 mi, in-bench)</h3>
        {SUPPORT_TIERS.map((t) => (
          <div className="item" key={t.key}>
            <span className="swatch" style={{ background: t.color }} />
            <span className="legend-label">{t.label}</span>
            {supportCounts && (
              <span className="legend-count">{_fmt.format(supportCounts[t.key] ?? 0)}</span>
            )}
          </div>
        ))}
        <div style={{ fontSize: 11, color: "#71717a", marginTop: 4 }}>
          Counts over BASE_CASE + EMERGING (scored). Verifiability, not quality —
          depleted areas score high; pair with Depletion.
        </div>
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
