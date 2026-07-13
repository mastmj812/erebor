import { useRef, useState } from "react";

import { selectByPolygon, uploadDeals } from "../api/select";
import { blueoxLegend, colorForBlueox } from "../map/formations";
import { CATEGORIES, categoryLabel } from "../map/sticksLayers";
import { useMapStore, type OverlayKey, type SelectionRule } from "../store";
import { ChipGroup } from "./ChipGroup";

const OVERLAY_LABELS: Record<OverlayKey, string> = {
  pads: "Pad / DSU polygons",
  grid: "Operated land grid",
  outline: "Basin outline",
  blocks: "Blocks (TX/NM grid)",
  sections: "Sections (numbered, z≥11)",
};

// Native inventory-tier names + a short descriptor. category wire values are
// unchanged (PUD=BASE_CASE, RES=EMERGING); see sticksLayers.categoryLabel.
const CATEGORY_HINT: Record<string, string> = {
  PDP: "producing",
  PUD: "undeveloped",
  RES: "resource",
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
  const setDealZoom = useMapStore((s) => s.setDealZoom);
  const unitFilter = useMapStore((s) => s.unitFilter);
  const setUnitFilter = useMapStore((s) => s.setUnitFilter);
  const colorMode = useMapStore((s) => s.colorMode);
  const setColorMode = useMapStore((s) => s.setColorMode);
  const formationFilter = useMapStore((s) => s.formationFilter);
  const toggleMapFormation = useMapStore((s) => s.toggleMapFormation);
  const clearMapFormations = useMapStore((s) => s.clearMapFormations);
  const remainingOnly = useMapStore((s) => s.remainingOnly);
  const toggleRemainingOnly = useMapStore((s) => s.toggleRemainingOnly);
  const excludeDepleted = useMapStore((s) => s.excludeDepleted);
  const toggleExcludeDepleted = useMapStore((s) => s.toggleExcludeDepleted);

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
  // formation_blueox codes present in this basin (same set the Legend shows).
  const formationCodes = blueoxLegend(basin).flatMap((g) => g.codes.map((c) => c.code));

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

  // Display-only: zoom the map to one deal polygon. Selection stays a manual
  // lasso/box draw — an uploaded shapefile never auto-selects sticks.
  const zoomToDeal = (index: number) => {
    const d = useMapStore.getState().deals?.find((x) => x.index === index);
    if (d) setDealZoom(d.geometry);
  };

  const onUpload = async (file: File) => {
    try {
      setBusy("Reading shapefile…");
      const ds = await uploadDeals(file);
      setDeals(ds); // MapView displays the polygons + fits the view to them
    } catch (e) {
      alert(`Shapefile upload failed: ${e}`);
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
          <label htmlFor={`cat-${c}`}>{categoryLabel(c)} ({CATEGORY_HINT[c]})</label>
        </div>
      ))}

      <div style={{ marginTop: 10 }}>
        <ChipGroup
          label="Formations (Blue Ox)"
          hint="Empty = all benches. Click to scout/screen specific ones — scopes the map, the selection rollup, and the export."
          options={formationCodes}
          selected={formationFilter}
          onToggle={toggleMapFormation}
          swatch={(code) => colorForBlueox(basin, code)}
        />
        {formationFilter.length > 0 && (
          <div style={{ fontSize: 11, color: "#71717a", marginTop: 2 }}>
            {formationFilter.length} bench{formationFilter.length === 1 ? "" : "es"} ·{" "}
            <button type="button" onClick={() => clearMapFormations()} style={{ fontSize: 11, cursor: "pointer" }}>clear</button>
          </div>
        )}
      </div>

      <h3 style={{ marginTop: 10 }}>Color sticks by</h3>
      <div className="seg">
        <button className={colorMode === "bench" ? "active" : ""} onClick={() => setColorMode("bench")}>Bench</button>
        <button className={colorMode === "status" ? "active" : ""} onClick={() => setColorMode("status")}>Recon status</button>
        <button className={colorMode === "depletion" ? "active" : ""} onClick={() => setColorMode("depletion")}>Depletion</button>
        <button className={colorMode === "support" ? "active" : ""} onClick={() => setColorMode("support")}>PDP support</button>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input id="remaining-only" type="checkbox" checked={remainingOnly} onChange={toggleRemainingOnly} />
        <label htmlFor="remaining-only">Remaining BASE_CASE only</label>
      </div>
      <div className="row">
        <input id="exclude-depleted" type="checkbox" checked={excludeDepleted} onChange={toggleExcludeDepleted} />
        <label htmlFor="exclude-depleted">Exclude depleted (Tier-4)</label>
      </div>

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
        Upload a shapefile (.zip) — displayed on the map only. Select wells with Lasso/Box.
      </div>
      {deals && deals.length > 0 && (
        <div className="row" style={{ marginBottom: 8 }}>
          <label htmlFor="deal-pick" style={{ fontSize: 12 }}>Zoom to:</label>
          <select
            id="deal-pick"
            style={{ flex: 1, fontSize: 12 }}
            value=""
            onChange={(e) => { if (e.target.value !== "") zoomToDeal(Number(e.target.value)); }}
          >
            <option value="" disabled>{deals.length} polygon{deals.length > 1 ? "s" : ""}…</option>
            {deals.map((d) => (
              <option key={d.index} value={d.index}>{d.label}</option>
            ))}
          </select>
          <button
            type="button"
            title="Remove the uploaded shapefile from the map"
            style={{ fontSize: 11, cursor: "pointer" }}
            onClick={() => setDeals(null)}
          >
            ✕
          </button>
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
