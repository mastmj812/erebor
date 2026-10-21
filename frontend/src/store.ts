import { create } from "zustand";

import type {
  AccGrid,
  AccHorizon,
  AccNorm,
  AccSelection,
  AccSummary,
  AccTier,
  AccVintages,
  AccWellDetail,
} from "./api/accuracy";
import type { BoxLegend, EconMetric, EurStream, Tier } from "./api/boxMap";
import type { BoxMeta, HighgradeFilters, ProxGroup } from "./api/highgrade";
import type { LocationWorkup } from "./api/workup";
import type { MapRange, RangeMetric } from "./map/screen";
import type { ColorMode } from "./map/sticksLayers";

export interface BasinMeta {
  basin: string;
  count: number;
  bbox: [number, number, number, number];
}

export type AppMode = "map" | "highgrade" | "accuracy";
export type OverlayKey = "pads" | "grid" | "outline" | "blocks" | "sections";
export type DrawMode = "off" | "lasso" | "box";
export type SelectionRule = "intersects" | "midpoint";
export type Phase = "oil" | "gas" | "water";
export type ChartMode = "rate" | "cum";
export type AggMode = "sum" | "avg"; // field total vs cohort MEAN per 1,000 ft (never P50, rule 18)

// BOX AOI profile (POST /production/box_profile): per bench, the record run's exact
// monthly volumes (D39, uptime-free) of the forecast-carrying locations in the AOI.
type StreamMonths = { oil: number[]; gas: number[]; water: number[] };
export interface BoxProfileBench {
  formation: string;
  n: number; n_validated: number; n_provisional: number; n_lateral: number; n_water_provisional: number;
  tier: "validated" | "provisional" | "mixed";
  sum: StreamMonths;          // field total, bbl or mcf per month
  per_kft_mean: StreamMonths; // cohort MEAN per 1,000 ft per month
}
export interface BoxProfile {
  box_run: { run_id: number; data_through: string };
  months: number;
  benches: BoxProfileBench[];
}
export interface WellProduction {
  name: string;
  forecast: { ip_day: number[]; oil: number[]; gas: number[]; water: number[] };
  forecast_end_day: number;
  arps_tail: { ip_day: number[]; oil: number[]; gas: number[]; water: number[] };
  has_forecast?: boolean;
  box?: WellBoxForecast | null; // BOX record run for this PUD (null = not a Novi PUD)
}
// BOX forecast for one PUD (backend app/api/box.well_forecast). Series only when forecast-carrying
// (covered = validated, covered_provisional = provisional tier, D105).
export interface BoxWellSeries { rate_day: number[]; rate: number[]; cum_day: number[]; cum: number[] }
export interface WellBoxForecast {
  run_id: number; data_through: string; coverage: string; stick_id: number;
  tier?: "validated" | "provisional" | null;
  lateral_ft: number | null; formation_blueox?: string;
  flags?: string[]; // the run's own sentences (tier, edge caveats, at-bound fits)
  eur: { oil: number | null; gas: number | null; water?: number | null };
  eur_per_kft: { oil: number | null; gas: number | null; water?: number | null };
  // water (sql/62): its own tier (validated on WCA / BS2_S covered rows, provisional elsewhere) and analog source
  water_tier?: "validated" | "provisional" | null;
  water_source?: "measured" | "calculated_fallback" | null;
  streams: Partial<Record<"oil" | "gas" | "water", BoxWellSeries>>;
}
export type WellSource = "novi" | "box" | "both";
export type BottomTab = "production" | "gunbarrel" | "workup";
export interface GunbarrelWell {
  stick_id: number; unique_id: string;
  category: string;                       // Map-tab gunbarrel: PDP | LOCATION (Novi's own tag is not shipped)
  formation: string;
  formation_blueox: string | null;        // Blue Ox bench code (intel_formation_blueox)
  basin_blueox: string | null;            // delaware | midland
  formation_blueox_source: string | null; // pdp_join | inferred | crosswalk | null
  // Map-tab gunbarrel (overhaul step 4): BOX record-run values; NULL = no BOX forecast, never zero
  coverage?: string | null;
  oil_eur_ft?: number | null; gas_eur_ft?: number | null; water_eur_ft?: number | null;
  prox_outcome?: string | null;
  econ?: number | null;                   // Steven's econ for the requested metric + deck (display only)
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

// One stick of an AOI selection (POST /select): BOX record-run values, Novi geometry only.
// NULL values = no BOX forecast (or unpriced) — never a zero. Econ = Steven's, display only (D13).
export interface SelectionStick {
  stick_id: number;
  unique_id: string;
  kind: "PDP" | "LOCATION";
  formation_blueox: string | null;
  pad_name: string | null;
  ll_ft: number | null;
  coverage: string | null;              // BOX class (NULL on PDP)
  water_tier: "validated" | "provisional" | null;
  oil_eur: number | null; gas_eur: number | null; water_eur: number | null;                       // bbl / mcf / bbl
  oil_eur_per_kft: number | null; gas_eur_per_kft: number | null; water_eur_per_kft: number | null;
  lat_basis_kft: number | null;         // lateral behind the stored per-kft (lateral-weighted rollups)
  prox_outcome: string | null;
  prox_factor: number | null;
  econ_pv0?: number | null; econ_pv10?: number | null; econ_pv15?: number | null; econ_pv20?: number | null;
  econ_pv25?: number | null; econ_pv30?: number | null; econ_irr?: number | null; econ_be_wti?: number | null;
  econ_capex?: number | null; econ_unpriced_reason?: string | null;
}
export interface DealFeature {
  index: number;
  label: string;
  geometry: GeoJSON.Geometry;
}
// Provenance of the econ case shown (D13).
export interface EconProvenance {
  deck_id: string; assumption_set_id: string; wti: number | null; hh: number | null;
  downtime_basis: string | null; built_at: string | null; pushed_at: string | null; pushed_by: string | null;
  n_priced: number;
}
export interface SelectionResult {
  count: number;
  truncated: boolean;
  rule: SelectionRule;
  box_run: { run_id: number; data_through: string; report_version: string };
  econ: EconProvenance | null; // null = the record run is not priced yet
  sticks: SelectionStick[];
}

// Highgrade tab: per-pad screening result (choropleth) from POST /highgrade/pads (BOX only).
export interface HighgradeResult {
  basin: string;
  metric: string;
  agg: string;               // applied: sum | avg | per_acre | median | lateral_weighted | count
  pad_count: number;
  pads_missing_geom: number;
  names_split: number;       // Novi pad names spanning >1 separate stick group, drawn as [k/n] pads (sql/67)
  pads_hull: number;         // drawn pads on a stick hull + 330 ft (stray / no Novi polygon), not Novi's DSU
  well_count: number;        // screened locations on a pad
  wells_without_pad: number; // screened locations with no pad assignment (not drawable)
  value_min: number | null;
  value_max: number | null;
  // color scale: P5 / P50 / P95 of the drawn, valued pads (the true range is value_min / value_max)
  value_p5: number | null; value_p50: number | null; value_p95: number | null;
  pads: GeoJSON.FeatureCollection;
  valued_count: number;      // locations carrying a value (BOX forecast; econ: priced)
  valued_by_tier: { validated: number; provisional: number }; // valued_count split by tier (D105)
  pads_unvalued: number;     // drawn pads with no valued location (grey, never zero)
  coverage_counts: Record<string, number>; // screened locations per coverage class
  // screened locations per PDP-proximity outcome group + the haircut factor range (D112–D116)
  proximity_counts: { as_is: number; haircut: number; no_precedent: number; factor_min: number | null; factor_max: number | null };
  box_run: { run_id: number; report_version: string; data_through: string; code_sha: string };
  econ: EconProvenance | null; // the econ case joined (D13 provenance); null = no econ in this screen
  econ_priced: boolean;        // the record run is priced at all
}

interface MapState {
  appMode: AppMode;
  highgrade: HighgradeResult | null;
  highgradeFilters: HighgradeFilters | null; // last-applied screen, drives the per-DSU gunbarrel
  boxMeta: BoxMeta | null;    // BOX record run + provenance + priced decks (per basin)
  hgGunbarrelPad: string | null;             // clicked DSU's pad_key (modal open when non-null)
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
  // Vintage mode (2026-09-18): null = live vintage (sql/38); a report_version
  // string ("2025Q3") reads the per-retained-vintage matview (sql/43).
  accVintage: string | null;
  accVintages: AccVintages | null;           // selector options (/accuracy/vintages)
  basin: "delaware" | "midland";
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
  excludedSticks: number[];     // manually culled stick_ids (dropped from rollup/plot)
  unitFilter: string[];         // map-only: substring terms matched against unique_id (OR)
  colorMode: ColorMode;         // map sticks: Blue Ox bench / BOX coverage / BOX EUR per ft / Steven econ
  eurStream: EurStream;         // color mode "eur": which stream
  econMetric: EconMetric;       // color mode "econ": which of Steven's columns (display-only, D13)
  mapDeck: string | null;       // color mode "econ": Steven's deck (null = default WTI 70 / HH 3)
  mapLegend: BoxLegend | null;  // ramp breaks for the active value mode (/api/box/legend)
  showPdp: boolean;             // map: producing context
  notCoveredShown: string[];    // map: classes of locations WITHOUT a BOX forecast drawn grey (empty = hidden, the default)
  tierFilter: Tier[];           // map: forecast tiers shown
  proxFilter: ProxGroup[];      // map: PDP-proximity outcome groups (empty = all)
  mapRanges: MapRange[];        // map screen: ranges on BOX EUR/ft, lateral, Steven's econ (map/screen.ts)
  production: BoxProfile | null;
  productionLoading: boolean;
  productionStale: boolean;     // culls changed since production was loaded
  productionPhase: Phase;
  chartMode: ChartMode;
  wellSource: WellSource; // single-well overlay: Novi, BOX, or both (BOX only when covered)
  aggMode: AggMode;
  wellOverlay: WellProduction | null;
  bottomTab: BottomTab;
  gunbarrel: GunbarrelData | null;
  gunbarrelLoading: boolean;
  // Single-location BOX workup (bottom window "Workup"): the clicked Novi stick location
  // (stick_id > 0), its loaded workup, the stick it was opened from (one step back), whether
  // the cohort is drawn on the map, and a zoom-to-cohort request (a fresh object re-fires).
  workupStickId: number | null;
  workupPrevId: number | null;
  workup: LocationWorkup | null;
  workupCache: Record<number, LocationWorkup>; // loaded this basin, so stepping back is instant
  workupLoading: boolean;
  workupOnMap: boolean;
  workupZoom: { n: number } | null;
  setAppMode: (m: AppMode) => void;
  setHighgrade: (h: HighgradeResult | null) => void;
  setHighgradeFilters: (f: HighgradeFilters | null) => void;
  setBoxMeta: (m: BoxMeta | null) => void;
  openHgGunbarrel: (padKey: string) => void;
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
  setAccVintage: (v: string | null) => void;
  setAccVintages: (v: AccVintages | null) => void;
  setBasin: (b: "delaware" | "midland") => void;
  toggleOverlay: (k: OverlayKey) => void;
  loadBasins: () => Promise<void>;
  setDrawMode: (m: DrawMode) => void;
  setSelectionRule: (r: SelectionRule) => void;
  setSelection: (s: SelectionResult | null, aoi: GeoJSON.Geometry | null) => void;
  replaceSelectionData: (s: SelectionResult) => void; // same AOI, new econ deck: keeps culls
  setDeals: (d: DealFeature[] | null) => void;
  setDealZoom: (g: GeoJSON.Geometry | null) => void;
  toggleFormation: (f: string) => void;
  toggleMapFormation: (code: string) => void;
  clearMapFormations: () => void;
  setUnitFilter: (u: string[]) => void;
  setColorMode: (m: ColorMode) => void;
  setEurStream: (s: EurStream) => void;
  setEconMetric: (m: EconMetric) => void;
  setMapDeck: (d: string | null) => void;
  setMapLegend: (l: BoxLegend | null) => void;
  setShowPdp: (b: boolean) => void;
  setNotCoveredShown: (classes: string[]) => void;
  toggleNotCovered: (cls: string) => void;
  toggleTier: (t: Tier) => void;
  toggleProx: (g: ProxGroup) => void;
  addMapRange: (m: RangeMetric) => void;
  updateMapRange: (i: number, patch: Partial<MapRange>) => void;
  removeMapRange: (i: number) => void;
  toggleStick: (id: number) => void;
  clearCulls: () => void;
  setProduction: (p: BoxProfile | null) => void;
  setProductionLoading: (b: boolean) => void;
  setProductionPhase: (p: Phase) => void;
  setWellSource: (s: WellSource) => void;
  setChartMode: (m: ChartMode) => void;
  setAggMode: (m: AggMode) => void;
  setWellOverlay: (w: WellProduction | null) => void;
  setBottomTab: (t: BottomTab) => void;
  setGunbarrel: (g: GunbarrelData | null) => void;
  setGunbarrelLoading: (b: boolean) => void;
  openWorkup: (stickId: number | null, fromNeighbour?: boolean) => void;
  setWorkup: (w: LocationWorkup | null) => void;
  setWorkupLoading: (b: boolean) => void;
  setWorkupOnMap: (b: boolean) => void;
  zoomToWorkup: () => void;
}

export const useMapStore = create<MapState>((set, get) => ({
  appMode: "map",
  highgrade: null,
  highgradeFilters: null,
  boxMeta: null,
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
  accVintage: null,
  accVintages: null,
  basin: "delaware",
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
  colorMode: "eur",
  eurStream: "oil",
  econMetric: "pv10",
  mapDeck: null,
  mapLegend: null,
  showPdp: true,
  notCoveredShown: [],
  tierFilter: ["validated", "provisional"],
  proxFilter: [],
  mapRanges: [],
  production: null,
  productionLoading: false,
  productionStale: false,
  productionPhase: "oil",
  chartMode: "rate",
  wellSource: "both", // BOX vs Novi: BOX is the forecast of record, Novi the comparison
  aggMode: "avg",
  wellOverlay: null,
  bottomTab: "production",
  gunbarrel: null,
  gunbarrelLoading: false,
  workupStickId: null,
  workupPrevId: null,
  workup: null,
  workupCache: {},
  workupLoading: false,
  workupOnMap: true,
  workupZoom: null,
  setAppMode: (m) => set({ appMode: m, hgGunbarrelPad: null, hgGunbarrel: null, hgGunbarrelLoading: false, accWellApi10: null, accWell: null, accWellLoading: false }),
  setHighgrade: (h) => set({ highgrade: h }),
  setHighgradeFilters: (f) => set({ highgradeFilters: f }),
  setBoxMeta: (m) => set({ boxMeta: m }),
  openHgGunbarrel: (padKey) => set({ hgGunbarrelPad: padKey, hgGunbarrel: null, hgGunbarrelLoading: true }),
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
  // Switching vintage invalidates every fetched accuracy surface; the tier
  // filter resets too (vintage mode has no proxy tier).
  setAccVintage: (v) =>
    set({
      accVintage: v, accWells: null, accSummary: null, accGrid: null,
      accSelection: null, accSelectionLoading: false,
      accWellApi10: null, accWell: null, accWellLoading: false,
      accTier: "all",
    }),
  setAccVintages: (v) => set({ accVintages: v }),
  setBasin: (b) =>
    set({ basin: b, highgrade: null, highgradeFilters: null, boxMeta: null, hgGunbarrelPad: null, hgGunbarrel: null, hgGunbarrelLoading: false, accWells: null, accSummary: null, accSummaryLoading: false, accTier: "all", accBench: [], accOperator: [], accWellApi10: null, accWell: null, accWellLoading: false, accSelection: null, accSelectionLoading: false, accMapView: "wells", accGrid: null, selection: null, aoi: null, deals: null, dealZoom: null, excludedFormations: [], formationFilter: [], excludedSticks: [], unitFilter: [], mapLegend: null, production: null, productionStale: false, wellOverlay: null, gunbarrel: null, workupStickId: null, workupPrevId: null, workup: null, workupCache: {}, workupLoading: false }),
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
  replaceSelectionData: (s) => set({ selection: s }),
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
  // A different color value (mode / stream / metric / deck) invalidates the legend. The
  // ranges are a screen of their own (any metric, independent of the color) and stay.
  setColorMode: (m) => set({ colorMode: m, mapLegend: null }),
  setEurStream: (st) => set({ eurStream: st, mapLegend: null }),
  setEconMetric: (m) => set({ econMetric: m, mapLegend: null }),
  setMapDeck: (d) => set({ mapDeck: d, mapLegend: null }),
  setMapLegend: (l) => set({ mapLegend: l }),
  setShowPdp: (b) => set({ showPdp: b }),
  setNotCoveredShown: (classes) => set({ notCoveredShown: classes }),
  toggleNotCovered: (cls) =>
    set((s) => ({ notCoveredShown: s.notCoveredShown.includes(cls) ? s.notCoveredShown.filter((x) => x !== cls) : [...s.notCoveredShown, cls] })),
  toggleTier: (t) =>
    set((s) => ({ tierFilter: s.tierFilter.includes(t) ? s.tierFilter.filter((x) => x !== t) : [...s.tierFilter, t] })),
  toggleProx: (g) =>
    set((s) => ({ proxFilter: s.proxFilter.includes(g) ? s.proxFilter.filter((x) => x !== g) : [...s.proxFilter, g] })),
  addMapRange: (m) => set((s) => ({ mapRanges: [...s.mapRanges, { metric: m, lo: null, hi: null }] })),
  updateMapRange: (i, patch) => set((s) => ({ mapRanges: s.mapRanges.map((r, k) => (k === i ? { ...r, ...patch } : r)) })),
  removeMapRange: (i) => set((s) => ({ mapRanges: s.mapRanges.filter((_, k) => k !== i) })),
  toggleStick: (id) =>
    set((s) => ({
      excludedSticks: s.excludedSticks.includes(id)
        ? s.excludedSticks.filter((x) => x !== id)
        : [...s.excludedSticks, id],
      productionStale: s.production ? true : s.productionStale,
    })),
  clearCulls: () =>
    set((s) => ({ excludedSticks: [], productionStale: s.production ? true : s.productionStale })),
  setProduction: (p) => set({ production: p, productionStale: false }),
  setProductionLoading: (b) => set({ productionLoading: b }),
  setProductionPhase: (p) => set({ productionPhase: p }),
  setWellSource: (s) => set({ wellSource: s }),
  setChartMode: (m) => set({ chartMode: m }),
  setAggMode: (m) => set({ aggMode: m }),
  setWellOverlay: (w) => set({ wellOverlay: w }),
  setBottomTab: (t) => set({ bottomTab: t }),
  setGunbarrel: (g) => set({ gunbarrel: g }),
  setGunbarrelLoading: (b) => set({ gunbarrelLoading: b }),
  // A map click opens a location fresh; a click on a neighbour inside the workup keeps the
  // location it came from, so the window can step back to it.
  openWorkup: (id, fromNeighbour = false) =>
    set((s) => (id === s.workupStickId ? {} : {
      workupStickId: id, workup: id != null ? s.workupCache[id] ?? null : null,
      workupPrevId: fromNeighbour ? s.workupStickId : null,
    })),
  setWorkup: (w) =>
    set((s) => (w == null ? { workup: null, workupLoading: false } : {
      workup: w.location.stick_id === s.workupStickId ? w : s.workup,
      workupCache: { ...s.workupCache, [w.location.stick_id]: w },
      workupLoading: false,
    })),
  setWorkupLoading: (b) => set({ workupLoading: b }),
  setWorkupOnMap: (b) => set({ workupOnMap: b }),
  zoomToWorkup: () => set((s) => ({ workupZoom: { n: (s.workupZoom?.n ?? 0) + 1 } })),
}));

export function basinBbox(meta: BasinMeta[], basin: string): [number, number, number, number] | null {
  return meta.find((m) => m.basin === basin)?.bbox ?? null;
}
