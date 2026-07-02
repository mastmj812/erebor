import type { GeoJsonPolygon } from "../map/drawing";
import type { DealFeature, SelectionResult, SelectionRule } from "../store";

export async function selectByPolygon(
  aoi: GeoJsonPolygon | GeoJSON.Geometry,
  basin: string,
  rule: SelectionRule,
): Promise<SelectionResult> {
  const r = await fetch("/api/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aoi, basin, rule }),
  });
  if (!r.ok) throw new Error(`select failed: ${r.status}`);
  return r.json();
}

// Parse a shapefile .zip into display-only polygons (no selection is run).
export async function uploadDeals(file: File): Promise<DealFeature[]> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/select/deals", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`deals upload failed: ${await r.text()}`);
  return (await r.json()).deals;
}
