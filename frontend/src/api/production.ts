import type { ProductionAggregate, SelectionRule, WellProduction } from "../store";

export async function fetchProductionAggregate(
  aoi: GeoJSON.Geometry,
  basin: string,
  rule: SelectionRule,
  exclude: string[] = [],
): Promise<ProductionAggregate> {
  const r = await fetch("/api/production/aggregate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aoi, basin, rule, exclude }),
  });
  if (!r.ok) throw new Error(`aggregate failed: ${r.status}`);
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
