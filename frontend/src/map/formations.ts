// Formation color palette + grouping. Shared by the MapLibre `match` paint
// expression (wellstick color) and the legend swatches — one source of truth.
//
// Strings match Novi Intelligence's formation values after UPPER() (the MVT
// endpoint emits UPPER(formation)). Copied from permian_type_curve with three
// additions observed in the Novi Intelligence data: AVALON, BRUSHY CANYON,
// DRINKARD. Anything unmatched falls back to OTHER_COLOR (slate).

export type FormationGroup = "Wolfcamp" | "Bone Spring" | "Spraberry" | "Other";

export interface FormationDef {
  name: string;
  group: FormationGroup;
  color: string;
}

export const FORMATIONS: FormationDef[] = [
  // ===== Wolfcamp (warm) =====
  { name: "WOLFCAMP A", group: "Wolfcamp", color: "#f97316" },
  { name: "WOLFCAMP A (XY)", group: "Wolfcamp", color: "#fb923c" },
  { name: "WOLFCAMP A (XY) SHELF", group: "Wolfcamp", color: "#fdba74" },
  { name: "WOLFCAMP B", group: "Wolfcamp", color: "#ef4444" },
  { name: "WOLFCAMP C", group: "Wolfcamp", color: "#b91c1c" },
  { name: "WOLFCAMP D", group: "Wolfcamp", color: "#7c2d12" },
  { name: "WOLFCAMP", group: "Wolfcamp", color: "#dc2626" },
  { name: "CLINE", group: "Wolfcamp", color: "#5b1b0a" },

  // ===== Bone Spring (blues / indigos) =====
  { name: "FIRST BONE SPRING", group: "Bone Spring", color: "#3b82f6" },
  { name: "FIRST BONE SPRING LIME", group: "Bone Spring", color: "#93c5fd" },
  { name: "SECOND BONE SPRING", group: "Bone Spring", color: "#2563eb" },
  { name: "SECOND BONE SPRING LIME", group: "Bone Spring", color: "#60a5fa" },
  { name: "THIRD BONE SPRING", group: "Bone Spring", color: "#0891b2" },
  { name: "THIRD BONE SPRING LIME", group: "Bone Spring", color: "#67e8f9" },
  { name: "BONE SPRING", group: "Bone Spring", color: "#1d4ed8" },
  { name: "BONE SPRING LIME", group: "Bone Spring", color: "#6366f1" },
  { name: "LEONARD", group: "Bone Spring", color: "#4f46e5" },
  // Avalon (Bone Spring system)
  { name: "AVALON", group: "Bone Spring", color: "#a78bfa" },
  { name: "UPPER AVALON", group: "Bone Spring", color: "#a5b4fc" },
  { name: "AVALON MIDDLE CARBONATE", group: "Bone Spring", color: "#818cf8" },
  { name: "LOWER AVALON", group: "Bone Spring", color: "#6366f1" },

  // ===== Spraberry (greens) =====
  { name: "UPPER SPRABERRY", group: "Spraberry", color: "#86efac" },
  { name: "MIDDLE SPRABERRY", group: "Spraberry", color: "#22c55e" },
  { name: "LOWER SPRABERRY SAND", group: "Spraberry", color: "#15803d" },
  { name: "LOWER SPRABERRY SHALE", group: "Spraberry", color: "#16a34a" },
  { name: "SPRABERRY", group: "Spraberry", color: "#65a30d" },
  { name: "JO MILL", group: "Spraberry", color: "#84cc16" },
  { name: "DEAN", group: "Spraberry", color: "#4d7c0f" },

  // ===== Other (purples / magentas / pinks) =====
  { name: "SAN ANDRES", group: "Other", color: "#a855f7" },
  { name: "PADDOCK", group: "Other", color: "#d946ef" },
  { name: "MISSISSIPPIAN", group: "Other", color: "#6b21a8" },
  { name: "DELAWARE", group: "Other", color: "#c026d3" },
  { name: "BRUSHY CANYON", group: "Other", color: "#9d174d" },
  { name: "SUB-WOODFORD", group: "Other", color: "#7e22ce" },
  { name: "WICHITA", group: "Other", color: "#9333ea" },
  { name: "STRAWN", group: "Other", color: "#be185d" },
  { name: "BARNETT", group: "Other", color: "#ec4899" },
  { name: "PENNSYLVANIAN", group: "Other", color: "#7c3aed" },
  { name: "WOODFORD", group: "Other", color: "#701a75" },
  { name: "BLINEBRY", group: "Other", color: "#581c87" },
  { name: "TUBB", group: "Other", color: "#4c1d95" },
  { name: "CLEAR FORK", group: "Other", color: "#c084fc" },
  { name: "GRAYBURG", group: "Other", color: "#e879f9" },
  { name: "ABO", group: "Other", color: "#a21caf" },
  { name: "DRINKARD", group: "Other", color: "#737373" },
  { name: "GLORIETA", group: "Other", color: "#be123c" },
  { name: "UNKNOWN", group: "Other", color: "#6b7280" },
];

export const OTHER_COLOR = "#6b7280"; // slate-500 fallback

const _COLOR_BY_UPPER = new Map(FORMATIONS.map((f) => [f.name.toUpperCase(), f.color]));

export function colorForFormation(name: string | null | undefined): string {
  if (!name) return OTHER_COLOR;
  return _COLOR_BY_UPPER.get(name.toUpperCase()) ?? OTHER_COLOR;
}

// Flatten [name, color, ...] for the MapLibre `match` expression.
export function formationMatchPairs(): string[] {
  const pairs: string[] = [];
  for (const f of FORMATIONS) pairs.push(f.name, f.color);
  return pairs;
}

export function groupedFormations(): Record<FormationGroup, FormationDef[]> {
  const groups: Record<FormationGroup, FormationDef[]> = {
    Wolfcamp: [],
    "Bone Spring": [],
    Spraberry: [],
    Other: [],
  };
  for (const f of FORMATIONS) groups[f.group].push(f);
  return groups;
}
