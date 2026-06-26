import { useRef, useState } from "react";

import { selectByPolygon, uploadDeals } from "../api/select";
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
  const deals = useMapStore((s) => s.deals);
  const setDeals = useMapStore((s) => s.setDeals);
  const unitFilter = useMapStore((s) => s.unitFilter);
  const setUnitFilter = useMapStore((s) => s.setUnitFilter);

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [unitText, setUnitText] = useState("");

  // Map-only filter: terms (one per line / comma-separated) matched against
  // unique_id, OR'd, with a trailing-digit guard so "Eddy Unit 10" doesn't also
  // catch "Eddy Unit 100". See stickFilter.
  const applyUnits = (text: string) => {
    setUnitText(text);
    setUnitFilter(text.split(/[\n,]/).map((t) => t.trim()).filter(Boolean));
  };

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

  // Pick one deal (polygon) from the uploaded shapefile as the AOI.
  const pickDeal = async (index: number) => {
    const d = useMapStore.getState().deals?.find((x) => x.index === index);
    if (!d) return;
    try {
      setBusy("Selecting deal…");
      const result = await selectByPolygon(d.geometry, basin, rule);
      setSelection(result, d.geometry);
    } catch (e) {
      alert(`Deal selection failed: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  const onUpload = async (file: File) => {
    try {
      setBusy("Reading deals…");
      const ds = await uploadDeals(file);
      setDeals(ds);
      if (ds.length === 1) void pickDeal(ds[0].index); // single-polygon shapefile
    } catch (e) {
      alert(`Deals upload failed: ${e}`);
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

      <h3 style={{ marginTop: 10 }}>Filter to unit(s)</h3>
      <textarea
        value={unitText}
        onChange={(e) => applyUnits(e.target.value)}
        placeholder={"e.g. Eddy Unit 10\nmatches unit name (no Unit 100 bleed); one per line / comma-separated"}
        rows={2}
        spellCheck={false}
        style={{ width: "100%", fontSize: 11, fontFamily: "monospace" }}
      />
      {unitFilter.length > 0 && (
        <div style={{ fontSize: 11, color: "#71717a", marginTop: 2 }}>
          {unitFilter.length} term{unitFilter.length === 1 ? "" : "s"} active ·{" "}
          <button type="button" onClick={() => applyUnits("")} style={{ fontSize: 11, cursor: "pointer" }}>clear</button>
        </div>
      )}

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
      <div style={{ fontSize: 11, color: "#71717a", margin: "4px 0 6px" }}>
        Upload a deals shapefile (.zip) — then pick one deal below.
      </div>
      {deals && deals.length > 0 && (
        <div className="row" style={{ marginBottom: 8 }}>
          <label htmlFor="deal-pick" style={{ fontSize: 12 }}>Deal:</label>
          <select
            id="deal-pick"
            style={{ flex: 1, fontSize: 12 }}
            defaultValue=""
            onChange={(e) => { if (e.target.value !== "") void pickDeal(Number(e.target.value)); }}
          >
            <option value="" disabled>{deals.length} deals — pick one…</option>
            {deals.map((d) => (
              <option key={d.index} value={d.index}>{d.label}</option>
            ))}
          </select>
        </div>
      )}

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
