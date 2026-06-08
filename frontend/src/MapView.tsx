import { useEffect, useRef, useState } from "react";
import maplibregl, {
  type Map as MlMap,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import layers from "protomaps-themes-base";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  INTEL_SOURCE,
  LINES_LAYER,
  LINES_SRC_LAYER,
  POINTS_LAYER,
  POINTS_SRC_LAYER,
  linesLayer,
  pointsLayer,
  stickFilter,
  tileUrl,
} from "./map/sticksLayers";
import { DrawingController, bboxToPolygon, type GeoJsonPolygon } from "./map/drawing";
import { selectByPolygon } from "./api/select";
import { fetchWellProduction } from "./api/production";
import { basinBbox, useMapStore, type OverlayKey } from "./store";

const AOI_SOURCE = "aoi";
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

let pmtilesRegistered = false;
function registerPmtilesProtocol() {
  if (pmtilesRegistered) return;
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  pmtilesRegistered = true;
}

function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sources: {
      protomaps: {
        type: "vector",
        url: "pmtiles:///api/basemap/permian.pmtiles",
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers("protomaps", "light", "en"),
  };
}

// Block / section number label expressions (reused from permian_type_curve —
// tuned for the TX GLO + NM survey GeoJSON; section number is LEVEL3_SUR).
const BLOCK_LABEL = ["coalesce", ["get", "BLOCK_NO"], ["get", "BLOCK"], ["get", "BlockNo"], ["get", "Block"], ["get", "block"], ["get", "BLOCKID"], ""];
const SECTION_LABEL = ["coalesce", ["get", "LEVEL3_SUR"], ["get", "SECTION_NO"], ["get", "SECTION"], ["get", "SEC"], ["get", "SectionNo"], ["get", "Section"], ["get", "section"], ["get", "SECTIONID"], ""];

// Per-basin Novi overlays (refetched + refit on basin change).
const NOVI_KEYS: OverlayKey[] = ["pads", "grid", "outline"];

// GeoJSON overlay definitions (source + layer specs). Source id is `ov-<key>`.
// pads/grid/outline are per-basin Novi layers; blocks/sections are a static
// TX+NM survey grid (basin param ignored) reused from permian_type_curve.
const OVERLAYS: Record<
  OverlayKey,
  { url: (b: string) => string; layers: any[] }
> = {
  pads: {
    url: (b) => `/api/layers/pads.geojson?basin=${b}`,
    layers: [
      { id: "ov-pads-fill", type: "fill", paint: { "fill-color": "#64748b", "fill-opacity": 0.07 } },
      { id: "ov-pads-line", type: "line", paint: { "line-color": "#334155", "line-width": 0.8, "line-opacity": 0.6 } },
    ],
  },
  grid: {
    url: (b) => `/api/layers/land_grid.geojson?basin=${b}`,
    layers: [
      { id: "ov-grid-line", type: "line", minzoom: 8, paint: { "line-color": "#475569", "line-width": 0.5, "line-opacity": 0.45 } },
    ],
  },
  outline: {
    url: (b) => `/api/layers/outline.geojson?basin=${b}`,
    layers: [
      { id: "ov-outline-line", type: "line", paint: { "line-color": "#1f2937", "line-width": 1.5, "line-opacity": 0.7 } },
    ],
  },
  blocks: {
    url: () => `/api/basemap/blocks.geojson`,
    layers: [
      { id: "ov-blocks-line", type: "line", minzoom: 8, paint: { "line-color": "#1e293b", "line-width": 0.9, "line-opacity": 0.55 } },
      {
        id: "ov-blocks-label", type: "symbol", minzoom: 8,
        layout: { "text-field": BLOCK_LABEL, "text-size": 12, "text-font": ["Noto Sans Regular"], "text-allow-overlap": false },
        paint: { "text-color": "#0f172a", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
      },
    ],
  },
  sections: {
    url: () => `/api/basemap/sections.geojson`,
    layers: [
      { id: "ov-sections-line", type: "line", minzoom: 11, paint: { "line-color": "#475569", "line-width": 0.6, "line-opacity": 0.5 } },
      {
        id: "ov-sections-label", type: "symbol", minzoom: 11,
        layout: { "text-field": SECTION_LABEL, "text-size": 10, "text-font": ["Noto Sans Regular"], "text-allow-overlap": false },
        paint: { "text-color": "#334155", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.25 },
      },
    ],
  },
};

// Remove only the per-basin Novi overlays (called on basin switch). The static
// blocks/sections grid covers both basins, so it's left in place.
function removeNoviOverlays(map: MlMap) {
  for (const key of NOVI_KEYS) {
    for (const l of OVERLAYS[key].layers) {
      if (map.getLayer(l.id)) map.removeLayer(l.id);
    }
    const srcId = `ov-${key}`;
    if (map.getSource(srcId)) map.removeSource(srcId);
  }
}

async function reconcileOverlay(map: MlMap, key: OverlayKey, visible: boolean, basin: string) {
  const def = OVERLAYS[key];
  const srcId = `ov-${key}`;
  if (visible) {
    if (!map.getSource(srcId)) {
      const r = await fetch(def.url(basin));
      if (!r.ok) return;
      map.addSource(srcId, { type: "geojson", data: await r.json() });
      for (const l of def.layers) {
        if (!map.getLayer(l.id)) map.addLayer({ ...l, source: srcId } as any);
      }
    } else {
      for (const l of def.layers) {
        if (map.getLayer(l.id)) map.setLayoutProperty(l.id, "visibility", "visible");
      }
    }
  } else {
    for (const l of def.layers) {
      if (map.getLayer(l.id)) map.setLayoutProperty(l.id, "visibility", "none");
    }
  }
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const drawerRef = useRef<DrawingController | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);

  const basin = useMapStore((s) => s.basin);
  const categories = useMapStore((s) => s.categories);
  const overlays = useMapStore((s) => s.overlays);
  const basinsMeta = useMapStore((s) => s.basinsMeta);
  const loadBasins = useMapStore((s) => s.loadBasins);
  const drawMode = useMapStore((s) => s.drawMode);
  const selection = useMapStore((s) => s.selection);
  const aoi = useMapStore((s) => s.aoi);
  const excludedFormations = useMapStore((s) => s.excludedFormations);

  // -------- init map (once) --------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    registerPmtilesProtocol();
    loadBasins();

    const runSelect = async (poly: GeoJsonPolygon) => {
      const { basin: b, selectionRule } = useMapStore.getState();
      try {
        const result = await selectByPolygon(poly, b, selectionRule);
        useMapStore.getState().setSelection(result, poly);
      } catch (e) {
        console.error("selection failed", e);
      }
    };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(),
      center: [-103.2, 31.9],
      zoom: 7,
      minZoom: 3,
      maxZoom: 15,
      hash: true,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

    const setup = () => {
      if (map.getSource(INTEL_SOURCE)) return;
      map.addSource(INTEL_SOURCE, {
        type: "vector",
        tiles: [tileUrl(useMapStore.getState().basin)],
        minzoom: 3,
        maxzoom: 14,
        promoteId: { intel_points: "stick_id", intel_lines: "stick_id" },
      });
      map.addLayer(linesLayer);
      map.addLayer(pointsLayer);

      // Committed AOI (drawn or uploaded) outline.
      map.addSource(AOI_SOURCE, { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "aoi-fill", type: "fill", source: AOI_SOURCE,
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.06 },
      });
      map.addLayer({
        id: "aoi-line", type: "line", source: AOI_SOURCE,
        paint: { "line-color": "#2563eb", "line-width": 2, "line-dasharray": [2, 1] },
      });

      // Draw controller: lasso / box -> run selection.
      const drawer = new DrawingController(map, {
        onPolygon: (poly) => void runSelect(poly),
        onBbox: (bbox) => void runSelect(bboxToPolygon(bbox)),
      });
      drawer.install();
      drawerRef.current = drawer;

      popupRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 8,
      });
      const onMove = (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        map.getCanvas().style.cursor = "pointer";
        popupRef.current!.setLngLat(e.lngLat).setHTML(popupHtml(f.properties)).addTo(map);
      };
      const onLeave = () => {
        map.getCanvas().style.cursor = "";
        popupRef.current?.remove();
      };
      for (const id of [POINTS_LAYER, LINES_LAYER]) {
        map.on("mousemove", id, onMove);
        map.on("mouseleave", id, onLeave);
      }
      // Click a stick (when not drawing) -> overlay its production profile.
      // Query a ±6px box so thin laterals / tiny points are easy to hit.
      const onMapClick = async (e: MapMouseEvent) => {
        if (useMapStore.getState().drawMode !== "off") return;
        const { x, y } = e.point;
        const feats = map.queryRenderedFeatures(
          [[x - 6, y - 6], [x + 6, y + 6]],
          { layers: [POINTS_LAYER, LINES_LAYER] },
        );
        const name = feats[0]?.properties?.unique_id as string | undefined;
        if (!name) return;
        try {
          const w = await fetchWellProduction(name, useMapStore.getState().basin);
          useMapStore.getState().setWellOverlay(w);
        } catch (err) {
          console.error("well production failed", err);
        }
      };
      map.on("click", onMapClick);
      setStyleLoaded(true);
    };
    map.on("load", setup);
    map.on("styledata", setup);

    mapRef.current = map;
    return () => {
      drawerRef.current?.uninstall();
      drawerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------- draw mode --------
  useEffect(() => {
    drawerRef.current?.setMode(drawMode);
  }, [drawMode]);

  // -------- selection -> feature-state highlight --------
  useEffect(() => {
    if (!styleLoaded) return;
    const map = mapRef.current;
    if (!map) return;
    for (const sl of [POINTS_SRC_LAYER, LINES_SRC_LAYER]) {
      map.removeFeatureState({ source: INTEL_SOURCE, sourceLayer: sl });
    }
    if (selection) {
      for (const id of selection.stick_ids) {
        for (const sl of [POINTS_SRC_LAYER, LINES_SRC_LAYER]) {
          map.setFeatureState({ source: INTEL_SOURCE, sourceLayer: sl, id }, { selected: true });
        }
      }
    }
  }, [selection, styleLoaded]);

  // -------- committed AOI outline --------
  useEffect(() => {
    if (!styleLoaded) return;
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(AOI_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      aoi
        ? ({ type: "Feature", properties: {}, geometry: aoi } as GeoJSON.Feature)
        : EMPTY_FC,
    );
  }, [aoi, styleLoaded]);

  // -------- basin change: swap tiles + refit + reset overlays --------
  useEffect(() => {
    if (!styleLoaded) return;
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource(INTEL_SOURCE) as maplibregl.VectorTileSource | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (src as any)?.setTiles?.([tileUrl(basin)]);
    removeNoviOverlays(map);
    const bbox = basinBbox(basinsMeta, basin);
    if (bbox) {
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 600 });
    }
    // Re-add whichever per-basin Novi overlays are currently on, for the new
    // basin. Static blocks/sections are untouched (they cover both basins).
    for (const key of NOVI_KEYS) {
      if (overlays[key]) void reconcileOverlay(map, key, true, basin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basin, styleLoaded, basinsMeta]);

  // -------- category + formation filter on both layers --------
  useEffect(() => {
    if (!styleLoaded) return;
    const map = mapRef.current;
    if (!map) return;
    const filt = stickFilter(categories, excludedFormations);
    for (const id of [POINTS_LAYER, LINES_LAYER]) {
      if (map.getLayer(id)) map.setFilter(id, filt);
    }
  }, [categories, excludedFormations, styleLoaded]);

  // -------- overlay toggles --------
  useEffect(() => {
    if (!styleLoaded) return;
    const map = mapRef.current;
    if (!map) return;
    for (const key of Object.keys(overlays) as OverlayKey[]) {
      void reconcileOverlay(map, key, overlays[key], basin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlays, styleLoaded]);

  return <div ref={containerRef} className="map-root" />;
}

function fmtInt(v: unknown): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Math.round(Number(v)).toLocaleString();
}
function fmtMoney(v: unknown): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `$${Math.round(Number(v)).toLocaleString()}`;
}
function esc(s: unknown): string {
  if (s == null) return "—";
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function popupHtml(p: Record<string, unknown>): string {
  return `
    <div>
      <div class="mtt-name">${esc(p.unique_id)}</div>
      <table class="mtt-table">
        <tr><td>Category</td><td>${esc(p.category)}</td></tr>
        <tr><td>Formation</td><td>${esc(p.formation)}</td></tr>
        <tr><td>Operator</td><td>${esc(p.operator)}</td></tr>
        <tr><td>Lateral</td><td>${fmtInt(p.ll_ft)} ft</td></tr>
        <tr><td>Oil EUR</td><td>${fmtInt(p.oil_eur)} bbl</td></tr>
        <tr><td>NPV25</td><td>${fmtMoney(p.npv25)}</td></tr>
      </table>
    </div>`;
}
