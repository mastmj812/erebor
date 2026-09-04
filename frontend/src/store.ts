import { create } from "zustand";

import { fetchDepletionCounts, fetchReconCounts, fetchSupportCounts } from "./api/recon";
import type {
  AccGrid,
  AccHorizon,
  AccNorm,
  AccSelection,
  AccSummary,
  AccTier,
  AccWellDetail,
} from "./api/accuracy";
import type { HighgradeFilters } from "./api/highgrade";
import { CATEGORIES, type Category, type ColorMode } from "./map/sticksLayers";

export interface BasinMeta {
  basin: string;
  count: number;
  bbox: [number, number, number, number];
}

export type AppMode = "map" | "highgrade" | "accuracy";
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
export type BottomTab = "production" | "gunbarrel";
export interface GunbarrelWell {
  stick_id: number; unique_id: string; category: string; formation: string;
  formation_blueox: string | null;        // Blue Ox bench code (intel_formation_blueox)
  basin_blueox: string | null;            // delaware | midland
  formation_blueox_source: string | null; // pdp_join | inferred | crosswalk | null
  recon_status: string | null;            // realized_pud_to_pdp | remaining_pud | conflict | net_new_pdp | null
  deplet_t: string | null;                // Novi depletion tier (Tier-1..4; Tier-4 = drained); null for PDP/RES
  pdp_count_3mi: number | null;           // offset-PDP support (3 mi, in-bench); null for PDP / unscorable
  tvd: number; ll_ft: number | null; offset_ft: number;
  in_filter?: boolean;          // set only by the Highgrade per-DSU gunbarrel
  metric_value?: number | null; // value of the selected screen metric (Highgrade)
}
export interface GunbarrelPad {
  pad_name: string; well_count: number;
  // Compass letters for the offset axis ends (suite-wide read: W→E for
  // ~N-S lateral sets, N→S for ~E-W). Absent on pre-axis payloads.
  axis_left?: string; axis_right?: string;
  wells: GunbarrelWell[];
}
export interface GunbarrelData { pad_count: number; pads: GunbarrelPad[] }

export interface SelectionStick {
  stick_id: number;
  unique_id: string;
  category: string;
  formation: string;
  formation_blueox: string | null;
  recon_status: string | null;  // §6 reconciliation tag (null for producers / RES)
  deplet_t: string | null;      // Novi depletion tier (Tier-4 = drained); null for PDP/RES
  pad_name: string | null;
  ll_ft: number | null;
  // Novi econ — NULL on PDP rows (curated producers carry no Novi screen value).
  npv5: number | null; npv10: number | null; npv15: number | null; npv20: number | null; npv25: number | null;
  pv5: number | null; pv10: number | null; pv15: number | null; pv20: number | null; pv25: number | null;
  oil_eur: number | null; gas_eur: number | null;
}
export interface DealFeature {
  index: number;
  label: string;
  geometry: GeoJSON.Geometry;
}
export interface PriceDeck {
  wti_price: number | null; hh_price: number | null; ngl_price: number | null;
  wti_diff: number | null; hh_diff: number | null; distinct_decks: number;
}
export interface SelectionResult {
  count: number;
  truncated: boolean;
  rule: SelectionRule;
  price_deck: PriceDeck;
  sticks: SelectionStick[];
}

// Highgrade tab: per-pad screening result (choropleth) from POST /highgrade/pads.
export interface HighgradeResult {
  basin: string;
  metric: string;
  agg: string;
  pad_count: number;
  pads_missing_geom: number;
  well_count: number;
  value_min: number | null;
  value_max: number | null;
  pads: GeoJSON.FeatureCollection;
}

interface MapState {
  appMode: AppMode;
  highgrade: HighgradeResult | null;
  highgradeFilters: HighgradeFilters | null; // last-applied screen, drives the per-DSU gunbarrel
  hgIncludeRealized: boolean; // Highgrade: false = drillable inventory only (drop §6 realized/phantom PUDs)
  hgGunbarrelPad: string | null;             // clicked DSU (modal open when non-null)
  hgGunbarrel: GunbarrelPad | null;          // loaded per-DSU wells
  hgGunbarrelLoading: boolean;
  // Accuracy tab: Novi forecast vs realized actuals (curated.intel_forecast_accuracy).
  accWells: GeoJSON.FeatureCollection | null; // /accuracy/wells layer data (per basin)
  accSummary: AccSummary | null;
  accSummaryLoading: boolean;
  accTier: AccTier;
  accStream: Phase;
  accNorm: AccNorm;        // per-ft (both tiers) vs raw volumes (direct only)
  accHorizon: AccHorizon;  // headline month (3/6/9/12)
  accBench: string[];      // bench filter (empty = all)
  accOperator: string[];   // operator filter (empty = all)
  accWellApi10: string | null;               // clicked well (modal open when non-null)
  accWell: AccWellDetail | null;
  accWellLoading: boolean;
  accSelection: AccSelection | null;         // lasso/box aggregate (modal open when non-null or loading)
  accSelectionLoading: boolean;
  accMapView: "wells" | "grid";              // per-well laterals vs regional bias cells
  accGrid: AccGrid | null;
  basin: "delaware" | "midland";
  categories: Category[];
  overlays: Record<OverlayKey, boolean>;
  basinsMeta: BasinMeta[];
  drawMode: DrawMode;
  selectionRule: SelectionRule;
  selection: SelectionResult | null;
  aoi: GeoJSON.Geometry | null;
  deals: DealFeature[] | null; // uploaded deals shapefile — displayed on the map only
  // Zoom-to-deal request (fresh wrapper object each pick so repeats re-fire).
  dealZoom: { geometry: GeoJSON.Geometry } | null;
  excludedFormations: string[]; // formation_blueox codes dropped from the rollup (post-selection trim)
  formationFilter: string[];    // map-scouting INCLUDE filter (empty = all); scopes map + rollup + export
  excludedSticks: number[];     // manually culled stick_ids (dropped from rollup/plot/export)
  unitFilter: string[];         // map-only: substring terms matched against unique_id (OR)
  colorMode: ColorMode;         // map sticks: Blue Ox bench / §6 reconciliation status / depletion tier
  reconCounts: Record<string, number> | null; // recon_status -> stick count for current basin (legend)
  depletionCounts: Record<string, number> | null; // deplet_t -> stick count for current basin (legend)
  supportCounts: Record<string, number> | null; // pdp support bucket -> PUD/RES count for current basin (legend)
  remainingOnly: boolean;       // map filter: among PUDs show only remaining (drillable)
  excludeDepleted: boolean;     // map filter: drop offset-depleted (Tier-4) PUDs
  discountRate: DiscountRate;
  valueMetric: ValueMetric;
  production: ProductionAggregate | null;
  productionLoading: boolean;
  productionStale: boolean;     // culls changed since production was loaded
  productionPhase: Phase;
  chartMode: ChartMode;
  aggMode: AggMode;
  wellOverlay: WellProduction | null;
  bottomTab: BottomTab;
  gunbarrel: GunbarrelData | null;
  gunbarrelLoading: boolean;
  setAppMode: (m: AppMode) => void;
  setHighgrade: (h: HighgradeResult | null) => void;
  setHighgradeFilters: (f: HighgradeFilters | null) => void;
  setHgIncludeRealized: (b: boolean) => void;
  openHgGunbarrel: (padName: string) => void;
  setHgGunbarrel: (g: GunbarrelPad | null) => void;
  closeHgGunbarrel: () => void;
  setAccWells: (fc: GeoJSON.FeatureCollection | null) => void;
  setAccSummary: (s: AccSummary | null) => void;
  setAccSummaryLoading: (b: boolean) => void;
  setAccTier: (t: AccTier) => void;
  setAccStream: (p: Phase) => void;
  setAccNorm: (n: AccNorm) => void;
  setAccHorizon: (h: AccHorizon) => void;
  toggleAccBench: (code: string) => void;
  toggleAccOperator: (op: string) => void;
  clearAccFilters: () => void;
  openAccWell: (api10: string) => void;
  setAccWell: (w: AccWellDetail | null) => void;
  closeAccWell: () => void;
  setAccSelectionLoading: (b: boolean) => void;
  setAccSelection: (sel: AccSelection | null, aoi: GeoJSON.Geometry | null) => void;
  clearAccSelection: () => void;
  setAccMapView: (v: "wells" | "grid") => void;
  setAccGrid: (g: AccGrid | null) => void;
  setBasin: (b: "delaware" | "midland") => void;
  toggleCategory: (c: Category) => void;
  toggleOverlay: (k: OverlayKey) => void;
  loadBasins: () => Promise<void>;
  setDrawMode: (m: DrawMode) => void;
  setSelectionRule: (r: SelectionRule) => void;
  setSelection: (s: SelectionResult | null, aoi: GeoJSON.Geometry | null) => void;
  setDeals: (d: DealFeature[] | null) => void;
  setDealZoom: (g: GeoJSON.Geometry | null) => void;
  toggleFormation: (f: string) => void;
  toggleMapFormation: (code: string) => void;
  clearMapFormations: () => void;
  setUnitFilter: (u: string[]) => void;
  setColorMode: (m: ColorMode) => void;
  loadReconCounts: () => Promise<void>;
  loadDepletionCounts: () => Promise<void>;
  loadSupportCounts: () => Promise<void>;
  toggleRemainingOnly: () => void;
  toggleExcludeDepleted: () => void;
  toggleStick: (id: number) => void;
  clearCulls: () => void;
  setDiscountRate: (r: DiscountRate) => void;
  setValueMetric: (m: ValueMetric) => void;
  setProduction: (p: ProductionAggregate | null) => void;
  setProductionLoading: (b: boolean) => void;
  setProductionPhase: (p: Phase) => void;
  setChartMode: (m: ChartMode) => void;
  setAggMode: (m: AggMode) => void;
  setWellOverlay: (w: WellProduction | null) => void;
  setBottomTab: (t: BottomTab) => void;
  setGunbarrel: (g: GunbarrelData | null) => void;
  setGunbarrelLoading: (b: boolean) => void;
}

export const useMapStore = create<MapState>((set, get) => ({
  appMode: "map",
  highgrade: null,
  highgradeFilters: null,
  hgIncludeRealized: false,
  hgGunbarrelPad: null,
  hgGunbarrel: null,
  hgGunbarrelLoading: false,
  accWells: null,
  accSummary: null,
  accSummaryLoading: false,
  accTier: "all",
  accStream: "oil",
  accNorm: "perft",
  accHorizon: 6,
  accBench: [],
  accOperator: [],
  accWellApi10: null,
  accWell: null,
  accWellLoading: false,
  accSelection: null,
  accSelectionLoading: false,
  accMapView: "wells",
  accGrid: null,
  basin: "delaware",
  categories: [...CATEGORIES],
  overlays: { pads: false, grid: false, outline: true, blocks: false, sections: false },
  basinsMeta: [],
  drawMode: "off",
  selectionRule: "intersects",
  selection: null,
  aoi: null,
  deals: null,
  dealZoom: null,
  excludedFormations: [],
  formationFilter: [],
  excludedSticks: [],
  unitFilter: [],
  colorMode: "bench",
  reconCounts: null,
  depletionCounts: null,
  supportCounts: null,
  remainingOnly: false,
  excludeDepleted: false,
  discountRate: 10,
  valueMetric: "npv",
  production: null,
  productionLoading: false,
  productionStale: false,
  productionPhase: "oil",
  chartMode: "rate",
  aggMode: "avg",
  wellOverlay: null,
  bottomTab: "production",
  gunbarrel: null,
  gunbarrelLoading: false,
  setAppMode: (m) => set({ appMode: m, hgGunbarrelPad: null, hgGunbarrel: null, hgGunbarrelLoading: false, accWellApi10: null, accWell: null, accWellLoading: false }),
  setHighgrade: (h) => set({ highgrade: h }),
  setHighgradeFilters: (f) => set({ highgradeFilters: f }),
  setHgIncludeRealized: (b) => set({ hgIncludeRealized: b }),
  openHgGunbarrel: (padName) => set({ hgGunbarrelPad: padName, hgGunbarrel: null, hgGunbarrelLoading: true }),
  setHgGunbarrel: (g) => set({ hgGunbarrel: g, hgGunbarrelLoading: false }),
  closeHgGunbarrel: () => set({ hgGunbarrelPad: null, hgGunbarrel: null, hgGunbarrelLoading: false }),
  setAccWells: (fc) => set({ accWells: fc }),
  setAccSummary: (s) => set({ accSummary: s, accSummaryLoading: false }),
  setAccSummaryLoading: (b) => set({ accSummaryLoading: b }),
  setAccTier: (t) =>
    // Raw-volume errors only exist on the direct tier — leaving raw selected
    // while switching away would blank the map, so fall back to per-ft.
    set((s) => ({ accTier: t, accNorm: t === "direct" ? s.accNorm : "perft" })),
  setAccStream: (p) => set({ accStream: p }),
  setAccNorm: (n) => set({ accNorm: n }),
  setAccHorizon: (h) => set({ accHorizon: h }),
  toggleAccBench: (code) =>
    set((s) => ({
      accBench: s.accBench.includes(code)
        ? s.accBench.filter((x) => x !== code)
        : [...s.accBench, code],
    })),
  toggleAccOperator: (op) =>
    set((s) => ({
      accOperator: s.accOperator.includes(op)
        ? s.accOperator.filter((x) => x !== op)
        : [...s.accOperator, op],
    })),
  clearAccFilters: () => set({ accTier: "all", accBench: [], accOperator: [] }),
  openAccWell: (api10) => set({ accWellApi10: api10, accWell: null, accWellLoading: true }),
  setAccWell: (w) => set({ accWell: w, accWellLoading: false }),
  closeAccWell: () => set({ accWellApi10: null, accWell: null, accWellLoading: false }),
  setAccSelectionLoading: (b) => set({ accSelectionLoading: b }),
  // Shares the map-tab `aoi` field for the drawn outline (the AOI layers are
  // mode-agnostic, matching how a Map-tab AOI stays visible in Highgrade).
  setAccSelection: (sel, aoi) => set({ accSelection: sel, aoi, accSelectionLoading: false }),
  clearAccSelection: () => set({ accSelection: null, accSelectionLoading: false, aoi: null }),
  setAccMapView: (v) => set({ accMapView: v }),
  setAccGrid: (g) => set({ accGrid: g }),
  setBasin: (b) =>
    set({ basin: b, highgrade: null, highgradeFilters: null, hgIncludeRealized: false, hgGunbarrelPad: null, hgGunbarrel: null, hgGunbarrelLoading: false, accWells: null, accSummary: null, accSummaryLoading: false, accTier: "all", accBench: [], accOperator: [], accWellApi10: null, accWell: null, accWellLoading: false, accSelection: null, accSelectionLoading: false, accMapView: "wells", accGrid: null, selection: null, aoi: null, deals: null, dealZoom: null, excludedFormations: [], formationFilter: [], excludedSticks: [], unitFilter: [], reconCounts: null, depletionCounts: null, supportCounts: null, remainingOnly: false, excludeDepleted: false, production: null, productionStale: false, wellOverlay: null, gunbarrel: null }),
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
  // A new selection starts with all formations included, no culls, clears derived data.
  setSelection: (s, aoi) =>
    set({ selection: s, aoi, excludedFormations: [], excludedSticks: [], production: null, productionStale: false, wellOverlay: null, gunbarrel: null }),
  setDeals: (d) => set({ deals: d, dealZoom: null }),
  setDealZoom: (g) => set({ dealZoom: g ? { geometry: g } : null }),
  toggleFormation: (f) =>
    set((s) => ({
      excludedFormations: s.excludedFormations.includes(f)
        ? s.excludedFormations.filter((x) => x !== f)
        : [...s.excludedFormations, f],
    })),
  // Map-scouting INCLUDE filter — persists across selections (only reset on basin
  // change), so scoping to a bench survives drawing/redrawing an AOI.
  toggleMapFormation: (code) =>
    set((s) => ({
      formationFilter: s.formationFilter.includes(code)
        ? s.formationFilter.filter((x) => x !== code)
        : [...s.formationFilter, code],
    })),
  clearMapFormations: () => set({ formationFilter: [] }),
  setUnitFilter: (u) => set({ unitFilter: u }),
  setColorMode: (m) => set({ colorMode: m }),
  loadReconCounts: async () => {
    if (get().reconCounts) return; // cached for the current basin (cleared by setBasin)
    try {
      set({ reconCounts: await fetchReconCounts(get().basin) });
    } catch (e) {
      console.warn("loadReconCounts failed", e);
    }
  },
  loadDepletionCounts: async () => {
    if (get().depletionCounts) return; // cached for the current basin (cleared by setBasin)
    try {
      set({ depletionCounts: await fetchDepletionCounts(get().basin) });
    } catch (e) {
      console.warn("loadDepletionCounts failed", e);
    }
  },
  loadSupportCounts: async () => {
    if (get().supportCounts) return; // cached for the current basin (cleared by setBasin)
    try {
      set({ supportCounts: await fetchSupportCounts(get().basin) });
    } catch (e) {
      console.warn("loadSupportCounts failed", e);
    }
  },
  // Both filters also drive the gun-barrel server query; clear the loaded
  // gun-barrel so it reloads with the new filter (mirrors setSelection).
  toggleRemainingOnly: () => set((s) => ({ remainingOnly: !s.remainingOnly, gunbarrel: null })),
  toggleExcludeDepleted: () => set((s) => ({ excludeDepleted: !s.excludeDepleted, gunbarrel: null })),
  toggleStick: (id) =>
    set((s) => ({
      excludedSticks: s.excludedSticks.includes(id)
        ? s.excludedSticks.filter((x) => x !== id)
        : [...s.excludedSticks, id],
      productionStale: s.production ? true : s.productionStale,
    })),
  clearCulls: () =>
    set((s) => ({ excludedSticks: [], productionStale: s.production ? true : s.productionStale })),
  setDiscountRate: (r) => set({ discountRate: r }),
  setValueMetric: (m) => set({ valueMetric: m }),
  setProduction: (p) => set({ production: p, productionStale: false }),
  setProductionLoading: (b) => set({ productionLoading: b }),
  setProductionPhase: (p) => set({ productionPhase: p }),
  setChartMode: (m) => set({ chartMode: m }),
  setAggMode: (m) => set({ aggMode: m }),
  setWellOverlay: (w) => set({ wellOverlay: w }),
  setBottomTab: (t) => set({ bottomTab: t }),
  setGunbarrel: (g) => set({ gunbarrel: g }),
  setGunbarrelLoading: (b) => set({ gunbarrelLoading: b }),
}));

export function basinBbox(meta: BasinMeta[], basin: string): [number, number, number, number] | null {
  return meta.find((m) => m.basin === basin)?.bbox ?? null;
}
