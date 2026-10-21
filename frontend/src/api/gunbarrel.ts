import type { EconMetric } from "./boxMap";
import type { GunbarrelData, SelectionRule } from "../store";

// AOI gunbarrel with BOX values per location; `econ` + `deck` add ONE of Steven's
// columns for the record run's case (display only, D13).
export async function fetchGunbarrel(
  aoi: GeoJSON.Geometry,
  basin: string,
  rule: SelectionRule,
  econ: EconMetric | null = null,
  deck: string | null = null,
): Promise<GunbarrelData> {
  const r = await fetch("/api/gunbarrel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aoi, basin, rule, econ, deck }),
  });
  if (!r.ok) throw new Error(`gunbarrel failed: ${r.status}`);
  return r.json();
}
