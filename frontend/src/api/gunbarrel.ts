import type { GunbarrelData, SelectionRule } from "../store";

export async function fetchGunbarrel(
  aoi: GeoJSON.Geometry,
  basin: string,
  rule: SelectionRule,
  remainingOnly = false,
  excludeDepleted = false,
): Promise<GunbarrelData> {
  const r = await fetch("/api/gunbarrel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aoi, basin, rule, remaining_only: remainingOnly, exclude_depleted: excludeDepleted }),
  });
  if (!r.ok) throw new Error(`gunbarrel failed: ${r.status}`);
  return r.json();
}
