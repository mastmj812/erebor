import { create } from "zustand";

import { CATEGORIES, type Category } from "./map/sticksLayers";

export interface BasinMeta {
  basin: string;
  count: number;
  bbox: [number, number, number, number];
}

export type OverlayKey = "pads" | "grid" | "outline" | "blocks" | "sections";
export type DrawMode = "off" | "lasso" | "box";
export type SelectionRule = "intersects" | "midpoint";
export type DiscountRate = 5 | 10 | 15 | 20 | 25;
export type ValueMetric = "npv" | "pv"; // NPV = net of well cost; PV = before cost
export type Phase = "oil" | "gas" | "water";
export type ChartMode = "rate" | "cum";
export type AggMode = "sum" | "avg"; // total field vs per-well type curve

export interface FormationStream {
  formation: string;
  oil: number[]; gas: number[]; water: number[];
  well_count: number;
}
export interface ProductionAggregate {
  ip_days: number[];
  formations: FormationStream[];
}
export interface WellProduction {
  name: string;
  forecast: { ip_day: number[]; oil: number[]; gas: number[]; water: number[] };
  forecast_end_day: number;
  arps_tail: { ip_day: number[]; oil: number[]; gas: number[]; water: number[] };
  has_forecast?: boolean;
}

export interface SelectionGroup {
  category: string;
  formation: string;
  count: number;
  npv5: number; npv10: number; npv15: number; npv20: number; npv25: number;
  pv5: number; pv10: number; pv15: number; pv20: number; pv25: number;
  oil_eur: number; gas_eur: number;
}
export interface PriceDeck {
  wti_price: number | null; hh_price: number | null; ngl_price: number | null;
  wti_diff: number | null; hh_diff: number | null; distinct_decks: number;
}
export interface SelectionResult {
  count: number;
  truncated: boolean;
  rule: SelectionRule;
  by_category: Record<string, number>;
  groups: SelectionGroup[];
  by_pad: { category: string; pad_name: string; count: number }[];
  price_deck: PriceDeck;
  stick_ids: number[];
}

interface MapState {
  basin: "delaware" | "midland";
  categories: Category[];
  overlays: Record<OverlayKey, boolean>;
  basinsMeta: BasinMeta[];
  drawMode: DrawMode;
  selectionRule: SelectionRule;
  selection: SelectionResult | null;
  aoi: GeoJSON.Geometry | null;
  excludedFormations: string[]; // UPPER formation names dropped from the rollup
  discountRate: DiscountRate;
  valueMetric: ValueMetric;
  production: ProductionAggregate | null;
  productionLoading: boolean;
  productionPhase: Phase;
  chartMode: ChartMode;
  aggMode: AggMode;
  wellOverlay: WellProduction | null;
  setBasin: (b: "delaware" | "midland") => void;
  toggleCategory: (c: Category) => void;
  toggleOverlay: (k: OverlayKey) => void;
  loadBasins: () => Promise<void>;
  setDrawMode: (m: DrawMode) => void;
  setSelectionRule: (r: SelectionRule) => void;
  setSelection: (s: SelectionResult | null, aoi: GeoJSON.Geometry | null) => void;
  toggleFormation: (f: string) => void;
  setDiscountRate: (r: DiscountRate) => void;
  setValueMetric: (m: ValueMetric) => void;
  setProduction: (p: ProductionAggregate | null) => void;
  setProductionLoading: (b: boolean) => void;
  setProductionPhase: (p: Phase) => void;
  setChartMode: (m: ChartMode) => void;
  setAggMode: (m: AggMode) => void;
  setWellOverlay: (w: WellProduction | null) => void;
}

export const useMapStore = create<MapState>((set, get) => ({
  basin: "delaware",
  categories: [...CATEGORIES],
  overlays: { pads: false, grid: false, outline: true, blocks: false, sections: false },
  basinsMeta: [],
  drawMode: "off",
  selectionRule: "intersects",
  selection: null,
  aoi: null,
  excludedFormations: [],
  discountRate: 10,
  valueMetric: "npv",
  production: null,
  productionLoading: false,
  productionPhase: "oil",
  chartMode: "rate",
  aggMode: "avg",
  wellOverlay: null,
  setBasin: (b) =>
    set({ basin: b, selection: null, aoi: null, excludedFormations: [], production: null, wellOverlay: null }),
  toggleCategory: (c) =>
    set((s) => ({
      categories: s.categories.includes(c)
        ? s.categories.filter((x) => x !== c)
        : [...s.categories, c],
    })),
  toggleOverlay: (k) =>
    set((s) => ({ overlays: { ...s.overlays, [k]: !s.overlays[k] } })),
  loadBasins: async () => {
    if (get().basinsMeta.length) return;
    try {
      const r = await fetch("/api/basins");
      if (r.ok) set({ basinsMeta: await r.json() });
    } catch (e) {
      console.warn("loadBasins failed", e);
    }
  },
  setDrawMode: (m) => set({ drawMode: m }),
  setSelectionRule: (r) => set({ selectionRule: r }),
  // A new selection starts with all formations included and clears production.
  setSelection: (s, aoi) =>
    set({ selection: s, aoi, excludedFormations: [], production: null, wellOverlay: null }),
  toggleFormation: (f) =>
    set((s) => ({
      excludedFormations: s.excludedFormations.includes(f)
        ? s.excludedFormations.filter((x) => x !== f)
        : [...s.excludedFormations, f],
    })),
  setDiscountRate: (r) => set({ discountRate: r }),
  setValueMetric: (m) => set({ valueMetric: m }),
  setProduction: (p) => set({ production: p }),
  setProductionLoading: (b) => set({ productionLoading: b }),
  setProductionPhase: (p) => set({ productionPhase: p }),
  setChartMode: (m) => set({ chartMode: m }),
  setAggMode: (m) => set({ aggMode: m }),
  setWellOverlay: (w) => set({ wellOverlay: w }),
}));

export function basinBbox(meta: BasinMeta[], basin: string): [number, number, number, number] | null {
  return meta.find((m) => m.basin === basin)?.bbox ?? null;
}
