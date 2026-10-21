import type { BoxProfile, SelectionRule, WellProduction } from "../store";

// BOX AOI profile: per bench, the record run's monthly volumes of the forecast-carrying
// locations in the AOI (field sum + cohort mean per 1,000 ft). Culls by stick_id; the bench
// include filter and the tier toggles mirror the map.
export async function fetchBoxProfile(
  aoi: GeoJSON.Geometry,
  basin: string,
  rule: SelectionRule,
  excludeSticks: number[] = [],
  formations: string[] = [],
  tiers: ("validated" | "provisional")[] = ["validated", "provisional"],
): Promise<BoxProfile> {
  const r = await fetch("/api/production/box_profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aoi, basin, rule, exclude_sticks: excludeSticks, formations, tiers }),
  });
  if (!r.ok) throw new Error(`BOX profile failed: ${r.status}`);
  return r.json();
}

export async function fetchWellProduction(
  name: string,
  basin: string,
): Promise<WellProduction> {
  const r = await fetch(
    `/api/production/well?basin=${basin}&name=${encodeURIComponent(name)}`,
  );
  if (!r.ok) throw new Error(`well production failed: ${r.status}`);
  return r.json();
}
