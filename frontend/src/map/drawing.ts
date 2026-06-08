// Lasso + box draw tools for AOI selection. ~150 lines, no extra dependency.
// Maintains a scratch GeoJSON source for live preview and emits a closed
// polygon (lasso) or a bbox (box drag) on mouse-up. Adapted from
// permian_type_curve/frontend/src/map/drawing.ts.

import type { GeoJSONSource, LngLat, Map as MlMap, MapMouseEvent } from "maplibre-gl";

import type { DrawMode } from "../store";

export type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] };

const SCRATCH_SOURCE_ID = "draw-scratch";
const SCRATCH_FILL_LAYER = "draw-scratch-fill";
const SCRATCH_LINE_LAYER = "draw-scratch-line";
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export interface DrawingCallbacks {
  onPolygon: (polygon: GeoJsonPolygon) => void;
  onBbox: (bbox: [number, number, number, number]) => void;
}

export class DrawingController {
  private mode: DrawMode = "off";
  private points: [number, number][] = [];
  private dragStart: LngLat | null = null;
  private dragging = false;
  private installed = false;

  constructor(
    private readonly map: MlMap,
    private readonly cb: DrawingCallbacks,
  ) {}

  install(): void {
    if (this.installed) return;
    if (!this.map.getSource(SCRATCH_SOURCE_ID)) {
      this.map.addSource(SCRATCH_SOURCE_ID, { type: "geojson", data: EMPTY_FC });
      this.map.addLayer({
        id: SCRATCH_FILL_LAYER, type: "fill", source: SCRATCH_SOURCE_ID,
        paint: { "fill-color": "#facc15", "fill-opacity": 0.15 },
      });
      this.map.addLayer({
        id: SCRATCH_LINE_LAYER, type: "line", source: SCRATCH_SOURCE_ID,
        paint: { "line-color": "#facc15", "line-width": 2 },
      });
    }
    this.map.on("mousedown", this.onMouseDown);
    this.map.on("mousemove", this.onMouseMove);
    this.map.on("mouseup", this.onMouseUp);
    this.installed = true;
  }

  uninstall(): void {
    if (!this.installed) return;
    this.map.off("mousedown", this.onMouseDown);
    this.map.off("mousemove", this.onMouseMove);
    this.map.off("mouseup", this.onMouseUp);
    this.clearScratch();
    this.installed = false;
  }

  setMode(mode: DrawMode): void {
    this.mode = mode;
    this.points = [];
    this.dragStart = null;
    this.dragging = false;
    this.clearScratch();
    if (mode === "lasso" || mode === "box") {
      this.map.dragPan.disable();
      this.map.getCanvas().style.cursor = "crosshair";
    } else {
      this.map.dragPan.enable();
      this.map.getCanvas().style.cursor = "";
    }
  }

  private onMouseDown = (e: MapMouseEvent): void => {
    if (this.mode === "lasso") {
      this.dragging = true;
      this.points = [[e.lngLat.lng, e.lngLat.lat]];
    } else if (this.mode === "box") {
      this.dragging = true;
      this.dragStart = e.lngLat;
    }
  };

  private onMouseMove = (e: MapMouseEvent): void => {
    if (!this.dragging) return;
    if (this.mode === "lasso") {
      this.points.push([e.lngLat.lng, e.lngLat.lat]);
      this.renderLasso();
    } else if (this.mode === "box" && this.dragStart) {
      this.renderBox(this.dragStart, e.lngLat);
    }
  };

  private onMouseUp = (e: MapMouseEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.mode === "lasso") {
      if (this.points.length >= 3) {
        const closed = [...this.points, this.points[0]!];
        this.cb.onPolygon({ type: "Polygon", coordinates: [closed] });
      }
      this.points = [];
    } else if (this.mode === "box" && this.dragStart) {
      const a = this.dragStart;
      const b = e.lngLat;
      const w = Math.min(a.lng, b.lng), ee = Math.max(a.lng, b.lng);
      const s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
      if (Math.abs(ee - w) > 1e-6 && Math.abs(n - s) > 1e-6) {
        this.cb.onBbox([w, s, ee, n]);
      }
      this.dragStart = null;
    }
    this.clearScratch();
  };

  private renderLasso(): void {
    const src = this.map.getSource(SCRATCH_SOURCE_ID) as GeoJSONSource | undefined;
    if (!src) return;
    const ring = [...this.points, this.points[0]!];
    src.setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
    });
  }

  private renderBox(a: LngLat, b: LngLat): void {
    const src = this.map.getSource(SCRATCH_SOURCE_ID) as GeoJSONSource | undefined;
    if (!src) return;
    const ring = [[a.lng, a.lat], [b.lng, a.lat], [b.lng, b.lat], [a.lng, b.lat], [a.lng, a.lat]];
    src.setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
    });
  }

  private clearScratch(): void {
    const src = this.map.getSource(SCRATCH_SOURCE_ID) as GeoJSONSource | undefined;
    src?.setData(EMPTY_FC);
  }
}

export function bboxToPolygon(b: [number, number, number, number]): GeoJsonPolygon {
  const [w, s, e, n] = b;
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}
