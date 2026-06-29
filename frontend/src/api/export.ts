import type { SelectionRule } from "../store";

// POST the current selection + filters and trigger a browser download of the
// xlsx workbook. The server sanitizes `filename` and appends .xlsx; its
// Content-Disposition name is the single source of truth for the download.
export async function exportSelection(
  aoi: GeoJSON.Geometry,
  basin: string,
  rule: SelectionRule,
  excludeWells: string[],
  excludeFormations: string[],
  filename: string,
  remainingOnly = false,
  excludeDepleted = false,
): Promise<void> {
  const r = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      aoi,
      basin,
      rule,
      exclude_wells: excludeWells,
      exclude_formations: excludeFormations,
      remaining_only: remainingOnly,
      exclude_depleted: excludeDepleted,
      filename,
    }),
  });
  if (!r.ok) throw new Error(`export failed: ${r.status}`);
  const blob = await r.blob();
  const cd = r.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "erebor_export.xlsx";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
