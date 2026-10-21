import { useEffect, useRef, useState } from "react";

import {
  ECON_METRICS,
  EUR_STREAMS,
  EUR_UNIT,
  MAP_COVERAGE_LABELS,
  PROX_FILTER_GROUPS,
  deckLabel,
  type EconMetric,
} from "../api/boxMap";
import { PROX_GROUP_LABELS, fetchBoxMeta, type ProxGroup } from "../api/highgrade";
import { selectByPolygon, uploadDeals } from "../api/select";
import { blueoxLegend, colorForBlueox } from "../map/formations";
import { NOT_COVERED_CLASSES, RANGE_METRICS, rangeMetricInfo, type RangeMetric } from "../map/screen";
import { useMapStore, type OverlayKey, type SelectionRule } from "../store";
import { ChipGroup } from "./ChipGroup";

const OVERLAY_LABELS: Record<OverlayKey, string> = {
  pads: "Novi DSU polygons (all, newest vintage)",
  grid: "Operated land grid",
  outline: "Basin outline",
  blocks: "Blocks (TX/NM grid)",
  sections: "Sections (numbered, z≥11)",
};

// "not_covered_outside_extent" -> its label without the trailing "(…)" note, for a chip.
const shortLabel = (k: string) => (MAP_COVERAGE_LABELS[k] ?? k).replace(/\s*\(.*\)\s*$/, "");

export function Controls() {
  const basin = useMapStore((s) => s.basin);
  const setBasin = useMapStore((s) => s.setBasin);
  const showPdp = useMapStore((s) => s.showPdp);
  const setShowPdp = useMapStore((s) => s.setShowPdp);
  const notCoveredShown = useMapStore((s) => s.notCoveredShown);
  const setNotCoveredShown = useMapStore((s) => s.setNotCoveredShown);
  const toggleNotCovered = useMapStore((s) => s.toggleNotCovered);
  const tierFilter = useMapStore((s) => s.tierFilter);
  const toggleTier = useMapStore((s) => s.toggleTier);
  const proxFilter = useMapStore((s) => s.proxFilter);
  const toggleProx = useMapStore((s) => s.toggleProx);
  const eurStream = useMapStore((s) => s.eurStream);
  const setEurStream = useMapStore((s) => s.setEurStream);
  const econMetric = useMapStore((s) => s.econMetric);
  const setEconMetric = useMapStore((s) => s.setEconMetric);
  const mapDeck = useMapStore((s) => s.mapDeck);
  const setMapDeck = useMapStore((s) => s.setMapDeck);
  const mapRanges = useMapStore((s) => s.mapRanges);
  const addMapRange = useMapStore((s) => s.addMapRange);
  const updateMapRange = useMapStore((s) => s.updateMapRange);
  const removeMapRange = useMapStore((s) => s.removeMapRange);
  const boxMeta = useMapStore((s) => s.boxMeta);
  const setBoxMeta = useMapStore((s) => s.setBoxMeta);
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

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [unitText, setUnitText] = useState("");
  // setBasin clears the store's unitFilter; clear the box with it so it never shows dead terms.
  useEffect(() => { setUnitText(""); }, [basin]);

  // BOX record run + scope + Steven's priced decks for this basin (shared with
  // Highgrade; setBasin clears it so it refetches per basin).
  useEffect(() => {
    if (boxMeta && boxMeta.basin === basin) return;
    let alive = true;
    fetchBoxMeta(basin)
      .then((m) => { if (alive) setBoxMeta(m); })
      .catch((e) => console.warn("BOX meta failed", e));
    return () => { alive = false; };
  }, [basin, boxMeta, setBoxMeta]);

  // Map-only filter: terms (one per line / comma-separated) matched against
  // unique_id, OR'd, with a trailing-digit guard so "Eddy Unit 10" doesn't also
  // catch "Eddy Unit 100". See stickFilter.
  const applyUnits = (text: string) => {
    setUnitText(text);
    setUnitFilter(text.split(/[\n,]/).map((t) => t.trim()).filter(Boolean));
  };

  const count = basinsMeta.find((m) => m.basin === basin)?.count;
  // formation_blueox codes present in this basin (same set the Legend shows), split
  // into the benches BOX forecasts (bench_scope in-scope pools) and the rest, plus an
  // "(unmapped)" chip for sticks with no bench (NULL formation_blueox).
  const allCodes = blueoxLegend(basin).flatMap((g) => g.codes.map((c) => c.code));
  const scope = boxMeta?.basin === basin ? boxMeta.scope : [];
  const boxSet = new Set(scope.filter((x) => x.in_scope).flatMap((x) => x.member_benches));
  const boxCodes = allCodes.filter((c) => boxSet.has(c));
  const otherCodes = [...allCodes.filter((c) => !boxSet.has(c)), "(unmapped)"];
  const pools = scope.filter((x) => x.in_scope && x.member_benches.length > 1);
  const decks = [...new Map((boxMeta?.decks ?? []).map((d) => [d.deck_id, d])).values()];
  const priced = boxMeta?.econ_status !== "not_yet_priced" && decks.length > 0;
  const noForecast = boxMeta != null && boxMeta.basin === basin && (boxMeta.forecast_count ?? 0) === 0;
  const num = (v: string): number | null => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const ncCounts = boxMeta?.basin === basin ? boxMeta.basin_coverage ?? {} : {};
  const ncAll = notCoveredShown.length === NOT_COVERED_CLASSES.length;
  // The record run's own not-covered classes it has no rows for (older-run classes such as
  // not_covered_wcxy) get no chip; the derived classes (not screened, realized, ...) always do.
  const ncOptions = NOT_COVERED_CLASSES.filter((k) => !k.startsWith("not_covered_") || !boxMeta || k in ncCounts);
  // A bench outside BOX has no forecast: picking its chip while its class is hidden would
  // blank the map, so say so and offer to show it.
  const pickedOther = formationFilter.filter((c) => otherCodes.includes(c));
  const otherHidden = pickedOther.length > 0 && !notCoveredShown.includes("bench_not_in_box");
  const econRanged = mapRanges.some((r) => rangeMetricInfo(r.metric).econ);
  const ncSummary = Object.entries(boxMeta?.basin_coverage ?? {})
    .map(([k, v]) => `${v.toLocaleString()} ${k.replace("not_covered_", "")}`)
    .join(", ");

  // Changing the rule re-runs selection on the current AOI (the toggle
  // materially changes counts — keep it live rather than forcing a redraw).
  const changeRule = async (r: SelectionRule) => {
    setSelectionRule(r);
    const aoi = useMapStore.getState().aoi;
    if (!aoi) return;
    try {
      setBusy("Re-selecting…");
      const result = await selectByPolygon(aoi, basin, r, useMapStore.getState().mapDeck);
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
      setBusy("Reading deal file…");
      const ds = await uploadDeals(file);
      setDeals(ds); // MapView displays the polygons + fits the view to them
    } catch (e) {
      alert(`Deal upload failed: ${e}`);
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
      {noForecast && (
        <div className="caveat">
          BOX does not forecast {basin === "midland" ? "Midland" : "this basin"} yet: no PUD here carries a BOX
          forecast{ncSummary ? ` (${ncSummary}; the rest are on benches outside BOX)` : ""}. Showing PDP context —
          turn on &ldquo;No BOX forecast&rdquo; to see the Novi stick locations. This lights up when a BOX record run covers the basin.
        </div>
      )}
      {boxMeta?.basin === basin && boxMeta.stale && (
        <div className="caveat">
          BOX record run {boxMeta.run.run_id} keys on Novi {boxMeta.run.report_version}; a newer Novi vintage is
          loaded, so coverage may read &ldquo;no BOX row&rdquo; until BOX refreshes.
        </div>
      )}

      <h3>Show</h3>
      <div className="row">
        <input id="show-validated" type="checkbox" checked={tierFilter.includes("validated")} onChange={() => toggleTier("validated")} />
        <label htmlFor="show-validated">BOX forecast — validated</label>
      </div>
      <div className="row">
        <input id="show-provisional" type="checkbox" checked={tierFilter.includes("provisional")} onChange={() => toggleTier("provisional")} />
        <label htmlFor="show-provisional">BOX forecast — PROVISIONAL tier</label>
      </div>
      <div className="row">
        <input id="show-pdp" type="checkbox" checked={showPdp} onChange={() => setShowPdp(!showPdp)} />
        <label htmlFor="show-pdp">PDP (producing context)</label>
      </div>
      <div className="row">
        <input
          id="show-nc" type="checkbox" checked={notCoveredShown.length > 0}
          ref={(el) => { if (el) el.indeterminate = notCoveredShown.length > 0 && !ncAll; }}
          onChange={() => setNotCoveredShown(notCoveredShown.length > 0 ? [] : [...NOT_COVERED_CLASSES])}
        />
        <label htmlFor="show-nc">No BOX forecast — grey, by reason</label>
      </div>
      {notCoveredShown.length > 0 && (
        <div style={{ marginLeft: 18 }}>
          <ChipGroup
            label="Reasons shown"
            hint="Never valued, never on a ramp. Counts = the record run's rows; the derived classes (not screened, bench not in BOX, realized) carry none."
            options={ncOptions}
            selected={notCoveredShown}
            onToggle={toggleNotCovered}
            labelOf={(k) => `${shortLabel(k)}${k in ncCounts ? ` · ${ncCounts[k].toLocaleString()}` : ""}`}
          />
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <ChipGroup
          label="PDP proximity"
          hint="Empty = all BOX forecasts. Haircut = multi-parent oil × factor (D113). No-precedent locations carry no forecast (under No BOX forecast)."
          options={PROX_FILTER_GROUPS}
          selected={proxFilter}
          onToggle={(g) => toggleProx(g as ProxGroup)}
          labelOf={(g) => PROX_GROUP_LABELS[g as ProxGroup]}
        />
      </div>

      <div style={{ marginTop: 10 }}>
        <ChipGroup
          label="Benches BOX forecasts"
          hint={`Empty = all benches. Scopes the map and the selection rollup.${pools.length ? ` Pools: ${pools.map((x) => `${x.bench} = ${x.member_benches.join(" + ")}`).join("; ")}.` : ""}`}
          options={boxCodes}
          selected={formationFilter}
          onToggle={toggleMapFormation}
          swatch={(code) => colorForBlueox(basin, code)}
        />
        <ChipGroup
          label="Other benches (no BOX forecast)"
          options={otherCodes}
          selected={formationFilter}
          onToggle={toggleMapFormation}
          swatch={(code) => colorForBlueox(basin, code)}
        />
        {otherHidden && (
          <div className="caveat">
            {pickedOther.join(", ")} {pickedOther.length === 1 ? "has" : "have"} no BOX forecast, so {pickedOther.length === 1 ? "its" : "their"} sticks
            read &ldquo;bench not in BOX&rdquo;, which is hidden.{" "}
            <button type="button" className="link" onClick={() => setNotCoveredShown([...new Set([...notCoveredShown, "bench_not_in_box"])])}>
              show them
            </button>
          </div>
        )}
        {formationFilter.length > 0 && (
          <div style={{ fontSize: 11, color: "#71717a", marginTop: 2 }}>
            {formationFilter.length} bench{formationFilter.length === 1 ? "" : "es"} ·{" "}
            <button type="button" onClick={() => clearMapFormations()} style={{ fontSize: 11, cursor: "pointer" }}>clear</button>
          </div>
        )}
      </div>

      <h3 style={{ marginTop: 10 }}>Color sticks by</h3>
      <div className="seg">
        <button className={colorMode === "eur" ? "active" : ""} onClick={() => setColorMode("eur")}>BOX EUR/ft</button>
        <button className={colorMode === "econ" ? "active" : ""} onClick={() => setColorMode("econ")}>Econ</button>
        <button className={colorMode === "coverage" ? "active" : ""} onClick={() => setColorMode("coverage")}>Coverage</button>
        <button className={colorMode === "bench" ? "active" : ""} onClick={() => setColorMode("bench")}>Bench</button>
      </div>
      {colorMode === "eur" && (
        <div className="seg sm" style={{ marginTop: 4 }}>
          {EUR_STREAMS.map((st) => (
            <button key={st} className={eurStream === st ? "active" : ""} onClick={() => setEurStream(st)}>
              {st} ({EUR_UNIT[st]})
            </button>
          ))}
        </div>
      )}
      {colorMode === "econ" && (
        <div style={{ marginTop: 4 }}>
          <div className="row">
            <select value={econMetric} onChange={(e) => setEconMetric(e.target.value as EconMetric)} style={{ flex: 1, fontSize: 12 }}>
              {ECON_METRICS.map((m) => <option key={m.value} value={m.value}>{m.label} ({m.unit})</option>)}
            </select>
            <select
              value={mapDeck ?? boxMeta?.default_deck ?? ""}
              onChange={(e) => setMapDeck(e.target.value || null)}
              disabled={!priced}
              style={{ flex: 1, fontSize: 12 }}
            >
              {decks.map((d) => <option key={d.deck_id} value={d.deck_id}>{deckLabel(d.deck_id, d.wti, d.hh)}</option>)}
            </select>
          </div>
          {!priced && boxMeta && (
            <div className="caveat">Not yet priced on BOX run {boxMeta.run.run_id} — econ appears when Steven pushes it.</div>
          )}
          <div style={{ fontSize: 11, color: "#71717a", marginTop: 2 }}>
            Steven&rsquo;s econ, display only — erebor computes no economics (D13).
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 10 }}>Screen BOX forecast locations</h3>
      {mapRanges.map((r, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
          <div className="row" style={{ alignItems: "center", gap: 4, marginBottom: 2 }}>
            <select
              value={r.metric} style={{ flex: 1, minWidth: 0, fontSize: 12 }}
              onChange={(e) => updateMapRange(i, { metric: e.target.value as RangeMetric, lo: null, hi: null })}
            >
              {RANGE_METRICS.map((m) => (
                <option key={m.value} value={m.value} disabled={m.econ && !priced}>{m.label}</option>
              ))}
            </select>
            <button type="button" title="Remove this range" style={{ fontSize: 11, cursor: "pointer" }} onClick={() => removeMapRange(i)}>✕</button>
          </div>
          <div className="row" style={{ alignItems: "center", gap: 4 }}>
            <input
              type="number" placeholder="min" value={r.lo ?? ""} style={{ flex: 1, minWidth: 0, fontSize: 12 }}
              onChange={(e) => updateMapRange(i, { lo: num(e.target.value) })}
            />
            <span style={{ fontSize: 11, color: "#71717a" }}>to</span>
            <input
              type="number" placeholder="max" value={r.hi ?? ""} style={{ flex: 1, minWidth: 0, fontSize: 12 }}
              onChange={(e) => updateMapRange(i, { hi: num(e.target.value) })}
            />
            <span style={{ fontSize: 11, color: "#71717a" }}>{rangeMetricInfo(r.metric).unit}</span>
          </div>
        </div>
      ))}
      <select
        value="" style={{ width: "100%", fontSize: 12 }}
        onChange={(e) => { if (e.target.value) addMapRange(e.target.value as RangeMetric); }}
      >
        <option value="" disabled>+ add a range…</option>
        {RANGE_METRICS.map((m) => (
          <option key={m.value} value={m.value} disabled={m.econ && !priced}>{m.label} ({m.unit})</option>
        ))}
      </select>
      <div style={{ fontSize: 11, color: "#71717a", marginTop: 2 }}>
        Every range applies at once, on top of the tier / proximity / bench filters; the color is independent. A forecast
        location with no value for a range fails it (e.g. no IRR). A range never hides a location without a BOX forecast.
        The lasso rollup, profile and gunbarrel use the same screen.
        {econRanged ? ` Econ ranges use ${deckLabel(mapDeck ?? boxMeta?.default_deck ?? "")} (Steven, display only).` : ""}
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
        accept=".zip,.gpkg"
        style={{ fontSize: 12, width: "100%" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }}
      />
      <div style={{ fontSize: 11, color: "#71717a", margin: "4px 0 6px" }}>
        Upload a shapefile (.zip) or GeoPackage (.gpkg) — displayed on the map only. Select wells with Lasso/Box.
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
