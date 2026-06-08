import type { GeoJsonPolygon } from "../map/drawing";
import type { SelectionResult, SelectionRule } from "../store";

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

export async function uploadShapefile(
  file: File,
  basin: string,
  rule: SelectionRule,
): Promise<SelectionResult & { aoi: GeoJSON.Geometry }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("basin", basin);
  fd.append("rule", rule);
  const r = await fetch("/api/select/shapefile", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`shapefile upload failed: ${await r.text()}`);
  return r.json();
}
