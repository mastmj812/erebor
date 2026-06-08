import type { GunbarrelData, SelectionRule } from "../store";

export async function fetchGunbarrel(
  aoi: GeoJSON.Geometry,
  basin: string,
  rule: SelectionRule,
): Promise<GunbarrelData> {
  const r = await fetch("/api/gunbarrel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aoi, basin, rule }),
  });
  if (!r.ok) throw new Error(`gunbarrel failed: ${r.status}`);
  return r.json();
}
