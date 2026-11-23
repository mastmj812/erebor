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
  boxSticks = false, // preview: also return the record BOX stick set (geometry only)
): Promise<GunbarrelData> {
  const r = await fetch("/api/gunbarrel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(boxSticks ? { aoi, basin, rule, econ, deck, box_sticks: true } : { aoi, basin, rule, econ, deck }),
  });
  if (!r.ok) throw new Error(`gunbarrel failed: ${r.status}`);
  return r.json();
}
