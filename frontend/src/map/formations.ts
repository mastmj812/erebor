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

// ===========================================================================
// Blue Ox standardized formation (formation_blueox codes from
// curated.intel_formation_blueox). Basin-aware code->color, ported from
// permian_type_curve (anduin). Intel covers only Delaware + Midland (no CBP);
// shared codes keep one color across basins. Used by the gun-barrel spot-check.
// ===========================================================================

export type BasinBlueox = "delaware" | "midland";

const SHARED_BLUEOX: Record<string, string> = {
  WCA_1: "#f97316", WCB_1: "#22c55e", WCB_2: "#ec4899", WCC: "#8b5cf6",
  WCD: "#0ea5e9", STRN: "#78716c", BRNT: "#2563eb", MISS: "#dc2626",
  WDFD: "#4d7c0f", OTHER: "#9ca3af",
};

export const BLUEOX_COLORS: Record<BasinBlueox, Record<string, string>> = {
  delaware: {
    ...SHARED_BLUEOX,
    AVA_0: "#06b6d4", AVA_1: "#f43f5e", AVA_2: "#84cc16",
    BS1_S: "#eab308", BS2_C: "#a855f7", BS2_S: "#14b8a6",
    BS3_C: "#fb923c", BS3_S: "#d946ef", WCXY: "#65a30d", WCA_2: "#e11d48",
  },
  midland: {
    ...SHARED_BLUEOX,
    US: "#06b6d4", MS: "#f43f5e", JM: "#a855f7",
    LSSH: "#eab308", DEAN: "#14b8a6", MRMC: "#d946ef",
  },
};

export function colorForBlueox(
  basin: string | null | undefined,
  code: string | null | undefined,
): string {
  if (!basin || !code) return OTHER_COLOR;
  return BLUEOX_COLORS[basin as BasinBlueox]?.[code] ?? OTHER_COLOR;
}

// MapLibre paint expression for the wellstick layers: nested `match` on
// basin_blueox -> formation_blueox -> color (built from BLUEOX_COLORS so the
// map and the SVG gun-barrel share one source of truth). Unmatched -> slate.
export function blueoxColorExpression(): unknown {
  const inner = (basin: BasinBlueox): unknown[] => {
    const pairs: unknown[] = [];
    for (const [code, color] of Object.entries(BLUEOX_COLORS[basin])) {
      pairs.push(code, color);
    }
    return ["match", ["get", "formation_blueox"], ...pairs, OTHER_COLOR];
  };
  return [
    "match",
    ["get", "basin_blueox"],
    "delaware", inner("delaware"),
    "midland", inner("midland"),
    OTHER_COLOR,
  ];
}

// code -> play group + display order, for the map legend.
const _BLUEOX_GROUP: Record<string, string> = {
  AVA_0: "Avalon", AVA_1: "Avalon", AVA_2: "Avalon",
  BS1_S: "Bone Spring", BS2_C: "Bone Spring", BS2_S: "Bone Spring",
  BS3_C: "Bone Spring", BS3_S: "Bone Spring",
  US: "Spraberry", MS: "Spraberry", JM: "Spraberry", LSSH: "Spraberry", DEAN: "Spraberry",
  WCXY: "Wolfcamp", WCA_1: "Wolfcamp", WCA_2: "Wolfcamp", WCB_1: "Wolfcamp",
  WCB_2: "Wolfcamp", WCC: "Wolfcamp", WCD: "Wolfcamp",
};
const _GROUP_ORDER = ["Avalon", "Bone Spring", "Spraberry", "Wolfcamp", "Other"];

// Blue Ox legend for the current basin: codes grouped by play, in display order.
export function blueoxLegend(
  basin: BasinBlueox,
): { group: string; codes: { code: string; color: string }[] }[] {
  const byGroup: Record<string, { code: string; color: string }[]> = {};
  for (const [code, color] of Object.entries(BLUEOX_COLORS[basin])) {
    const g = _BLUEOX_GROUP[code] ?? "Other";
    (byGroup[g] ??= []).push({ code, color });
  }
  return _GROUP_ORDER.filter((g) => byGroup[g]?.length).map((g) => ({ group: g, codes: byGroup[g] }));
}

// formation_blueox_source -> color, for the gun-barrel "color by source" toggle.
// Ordered most-trusted -> least for the legend.
export const BLUEOX_SOURCES: { key: string; label: string; color: string }[] = [
  { key: "pdp_join", label: "PDP (actual well)", color: "#10b981" },
  { key: "crosswalk", label: "crosswalk", color: "#3b82f6" },
  { key: "inferred", label: "inferred (KNN)", color: "#f59e0b" },
  { key: "tvd_corrected", label: "TVD-corrected", color: "#a855f7" },
  { key: "(null)", label: "unmapped", color: OTHER_COLOR },
];

const _SOURCE_COLOR = new Map(BLUEOX_SOURCES.map((s) => [s.key, s.color]));

export function colorForSource(source: string | null | undefined): string {
  return _SOURCE_COLOR.get(source ?? "(null)") ?? OTHER_COLOR;
}

// ===========================================================================
// §6 reconciliation status (recon_status from curated.erebor_locations).
// PUD -> remaining / realized_drift / realized_phantom / conflict; PDP -> net_new;
// RES + ordinary producers -> null (slate). Used by the map + gun-barrel status mode.
// realized is split by vintage: DRIFT = drilled since the 3Q25 vintage (real
// PUD->PDP), PHANTOM = Novi listed a slot already drilled years ago (data hygiene).
// ===========================================================================
export const RECON_OTHER = "#cbd5e1"; // slate-300: RES / ordinary producers / null

export const RECON_STATUS: { key: string; label: string; color: string }[] = [
  { key: "remaining_pud", label: "remaining PUD", color: "#10b981" }, // emerald
  { key: "realized_drift", label: "realized (drift)", color: "#9ca3af" }, // grey — real PUD->PDP
  { key: "realized_phantom", label: "realized (phantom)", color: "#fb7185" }, // rose — Novi already-drilled slot
  { key: "conflict", label: "conflict", color: "#f59e0b" }, // amber
  { key: "net_new_pdp", label: "net-new PDP", color: "#a855f7" }, // violet
  { key: "(null)", label: "other (RES / PDP)", color: RECON_OTHER },
];

const _STATUS_COLOR = new Map(RECON_STATUS.map((s) => [s.key, s.color]));

export function colorForStatus(status: string | null | undefined): string {
  return _STATUS_COLOR.get(status ?? "(null)") ?? RECON_OTHER;
}

// MapLibre paint expression: match recon_status -> color; null/unmatched -> slate.
export function statusColorExpression(): unknown {
  const pairs: unknown[] = [];
  for (const s of RECON_STATUS) {
    if (s.key === "(null)") continue;
    pairs.push(s.key, s.color);
  }
  return ["match", ["get", "recon_status"], ...pairs, RECON_OTHER];
}

// ===========================================================================
// Novi PUD depletion tier (deplet_t). Tier-4 = offset-depleted / drained rock
// (the frac grows into the depleted offset; produces water) — technically
// drillable, worthless. Green (clean) -> red (drained); PDP/RES are unscored
// (deplet_t NULL) -> slate. Used by the map depletion color mode + gun-barrel.
// ===========================================================================
export const DEPLETION_TIERS: { key: string; label: string; color: string }[] = [
  { key: "Tier-1", label: "Tier-1 (clean)", color: "#16a34a" },   // green
  { key: "Tier-2", label: "Tier-2", color: "#84cc16" },           // lime
  { key: "Tier-3", label: "Tier-3", color: "#f59e0b" },           // amber
  { key: "Tier-4", label: "Tier-4 (depleted)", color: "#dc2626" }, // red
  { key: "(null)", label: "PDP / RES (unscored)", color: RECON_OTHER },
];

const _DEPLETION_COLOR = new Map(DEPLETION_TIERS.map((t) => [t.key, t.color]));

export function colorForDepletion(tier: string | null | undefined): string {
  return _DEPLETION_COLOR.get(tier ?? "(null)") ?? RECON_OTHER;
}

// MapLibre paint expression: match deplet_t -> color; null/unmatched -> slate.
export function depletionColorExpression(): unknown {
  const pairs: unknown[] = [];
  for (const t of DEPLETION_TIERS) {
    if (t.key === "(null)") continue;
    pairs.push(t.key, t.color);
  }
  return ["match", ["get", "deplet_t"], ...pairs, RECON_OTHER];
}
