import { useRef, useState } from "react";

import { selectByPolygon, uploadShapefile } from "../api/select";
import { CATEGORIES } from "../map/sticksLayers";
import { useMapStore, type OverlayKey, type SelectionRule } from "../store";

const OVERLAY_LABELS: Record<OverlayKey, string> = {
  pads: "Pad / DSU polygons",
  grid: "Operated land grid",
  outline: "Basin outline",
  blocks: "Blocks (TX/NM grid)",
  sections: "Sections (numbered, z≥11)",
};

const CATEGORY_LABELS: Record<string, string> = {
  PDP: "PDP (producing)",
  PUD: "PUD (undeveloped)",
  RES: "RESOURCE",
};

export function Controls() {
  const basin = useMapStore((s) => s.basin);
  const setBasin = useMapStore((s) => s.setBasin);
  const categories = useMapStore((s) => s.categories);
  const toggleCategory = useMapStore((s) => s.toggleCategory);
  const overlays = useMapStore((s) => s.overlays);
  const toggleOverlay = useMapStore((s) => s.toggleOverlay);
  const basinsMeta = useMapStore((s) => s.basinsMeta);
  const drawMode = useMapStore((s) => s.drawMode);
  const setDrawMode = useMapStore((s) => s.setDrawMode);
  const rule = useMapStore((s) => s.selectionRule);
  const setSelectionRule = useMapStore((s) => s.setSelectionRule);
  const setSelection = useMapStore((s) => s.setSelection);

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const count = basinsMeta.find((m) => m.basin === basin)?.count;

  // Changing the rule re-runs selection on the current AOI (the toggle
  // materially changes counts — keep it live rather than forcing a redraw).
  const changeRule = async (r: SelectionRule) => {
    setSelectionRule(r);
    const aoi = useMapStore.getState().aoi;
    if (!aoi) return;
    try {
      setBusy("Re-selecting…");
      const result = await selectByPolygon(aoi, basin, r);
      setSelection(result, aoi);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
    }
  };

  const onUpload = async (file: File) => {
    try {
      setBusy("Uploading shapefile…");
      const result = await uploadShapefile(file, basin, rule);
      const { aoi, ...sel } = result;
      setSelection(sel, aoi);
    } catch (e) {
      alert(`Shapefile selection failed: ${e}`);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="panel controls">
      <h3>Basin</h3>
      <div className="seg">
        <button className={basin === "delaware" ? "active" : ""} onClick={() => setBasin("delaware")}>Delaware</button>
        <button className={basin === "midland" ? "active" : ""} onClick={() => setBasin("midland")}>Midland</button>
      </div>
      {count != null && <div className="count">{count.toLocaleString()} locations</div>}

      <h3>Categories</h3>
      {CATEGORIES.map((c) => (
        <div className="row" key={c}>
          <input id={`cat-${c}`} type="checkbox" checked={categories.includes(c)} onChange={() => toggleCategory(c)} />
          <label htmlFor={`cat-${c}`}>{CATEGORY_LABELS[c]}</label>
        </div>
      ))}

      <h3 style={{ marginTop: 10 }}>Define AOI</h3>
      <div className="seg">
        <button className={drawMode === "lasso" ? "active" : ""} onClick={() => setDrawMode(drawMode === "lasso" ? "off" : "lasso")}>Lasso</button>
        <button className={drawMode === "box" ? "active" : ""} onClick={() => setDrawMode(drawMode === "box" ? "off" : "box")}>Box</button>
        <button onClick={() => { setDrawMode("off"); setSelection(null, null); }}>Clear</button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".zip"
        style={{ fontSize: 12, width: "100%" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }}
      />
      <div style={{ fontSize: 11, color: "#71717a", margin: "4px 0 8px" }}>
        Upload a deal shapefile (.zip with .shp/.dbf/.prj)
      </div>

      <h3>Selection rule</h3>
      <div className="seg">
        <button className={rule === "intersects" ? "active" : ""} onClick={() => void changeRule("intersects")}>Intersects</button>
        <button className={rule === "midpoint" ? "active" : ""} onClick={() => void changeRule("midpoint")}>Midpoint</button>
      </div>
      {busy && <div className="count">{busy}</div>}

      <h3 style={{ marginTop: 10 }}>Overlays</h3>
      {(Object.keys(OVERLAY_LABELS) as OverlayKey[]).map((k) => (
        <div className="row" key={k}>
          <input id={`ov-${k}`} type="checkbox" checked={overlays[k]} onChange={() => toggleOverlay(k)} />
          <label htmlFor={`ov-${k}`}>{OVERLAY_LABELS[k]}</label>
        </div>
      ))}
    </div>
  );
}
