import { useCallback, useRef, useState } from "react";

import { fetchBoxProfile } from "../api/production";
import { colorForBlueox } from "../map/formations";
import { stickPasses } from "../map/screen";
import { COVERAGE_LABELS, isForecastClass } from "../api/highgrade";
import { useMapStore, type Phase, type WellSource } from "../store";
import { LineChart, type Series } from "./LineChart";

const PHASES: Phase[] = ["oil", "gas", "water"];
const STEP_DAYS = 30; // Novi forecast cadence (single-well comparison curve)
const DAYS_PER_MONTH = 365.25 / 12; // BOX monthly volumes (exact per-month integrals, D39)

function cumsum(vals: number[]): number[] {
  let acc = 0;
  return vals.map((v) => (acc += v * STEP_DAYS));
}
const yrs = (days: number[]) => days.map((d) => d / 365);

// Measure the CHART'S OWN box, not the window body. Sizing the chart as "body minus a
// guessed header height" let a wrapping header (well tag, BOX note) push the content
// past the body: a scrollbar appeared, the body narrowed, the chart re-sized, the
// scrollbar vanished, and the window flickered until it was made larger. Here the
// header takes what it needs and the chart fills exactly what is left (whole pixels).
function useBoxSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const roRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      const next = { width: Math.floor(cr.width), height: Math.floor(cr.height) };
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);
  return [ref, size] as const;
}

// width / height props are accepted for the caller's compatibility but no longer used:
// the chart sizes itself from its own box (useBoxSize).
export function ProductionView(_props: { width?: number; height?: number }) {
  const [chartRef, chartSize] = useBoxSize();
  const aoi = useMapStore((s) => s.aoi);
  const basin = useMapStore((s) => s.basin);
  const rule = useMapStore((s) => s.selectionRule);
  const excluded = useMapStore((s) => s.excludedFormations);
  const formationFilter = useMapStore((s) => s.formationFilter);
  const tierFilter = useMapStore((s) => s.tierFilter);
  const proxFilter = useMapStore((s) => s.proxFilter);
  const mapRanges = useMapStore((s) => s.mapRanges);
  const sel = useMapStore((s) => s.selection);
  const prod = useMapStore((s) => s.production);
  const loading = useMapStore((s) => s.productionLoading);
  const phase = useMapStore((s) => s.productionPhase);
  const mode = useMapStore((s) => s.chartMode);
  const agg = useMapStore((s) => s.aggMode);
  const overlay = useMapStore((s) => s.wellOverlay);
  const excludedSticks = useMapStore((s) => s.excludedSticks);
  const stale = useMapStore((s) => s.productionStale);
  const wellSource = useMapStore((s) => s.wellSource);
  const st = useMapStore;
  // The profile's location set = the map's: the server applies the bench filter and tiers; the
  // proximity and range screens (map/screen.ts) go as exclusions with the culls. `screenKey`
  // marks the loaded profile stale when the screen changes after it was loaded.
  const screenKey = JSON.stringify([formationFilter, tierFilter, proxFilter, mapRanges]);
  const loadedKey = useRef<string | null>(null);
  const screenStale = prod != null && loadedKey.current != null && loadedKey.current !== screenKey;

  const load = async () => {
    if (!aoi) return;
    st.getState().setProductionLoading(true);
    try {
      const screened = (sel?.sticks ?? [])
        .filter((s) => s.kind === "LOCATION" && isForecastClass(s.coverage)
          && !stickPasses(s, { tiers: tierFilter, prox: proxFilter, ranges: mapRanges }))
        .map((s) => s.stick_id);
      const key = screenKey;
      const p = await fetchBoxProfile(aoi, basin, rule, [...excludedSticks, ...screened], formationFilter, tierFilter);
      loadedKey.current = key;
      st.getState().setProduction(p);
    } catch (e) {
      console.error(e);
    } finally {
      st.getState().setProductionLoading(false);
    }
  };

  const exSet = new Set(excluded);
  const series: Series[] = [];
  if (prod) {
    // BOX AOI profile per bench: avg = cohort MEAN per 1,000 ft (never P50, rule 18); sum = field
    // total. Monthly volumes are uptime-free, so "rate" = volume / days in month (not a calendar
    // rate). PROVISIONAL benches (and provisional water) draw dashed (D105).
    const xs = Array.from({ length: prod.months }, (_, k) => (k + 0.5) * DAYS_PER_MONTH / 365);
    const xsCum = Array.from({ length: prod.months }, (_, k) => (k + 1) * DAYS_PER_MONTH / 365);
    for (const b of prod.benches) {
      if (exSet.has(b.formation)) continue;
      const vols = (agg === "avg" ? b.per_kft_mean : b.sum)[phase];
      let acc = 0;
      const prov = b.tier === "provisional" || (phase === "water" && b.n_water_provisional === b.n);
      series.push({
        label: `${b.formation} (${b.n}${b.tier === "provisional" ? " PROV" : b.tier === "mixed" ? " mixed" : ""})`,
        color: colorForBlueox(basin, b.formation),
        xs: mode === "rate" ? xs : xsCum,
        ys: mode === "rate" ? vols.map((v) => v / DAYS_PER_MONTH) : vols.map((v) => (acc += v)),
        dashed: prov,
      });
    }
  }
  // BOX for the clicked well: offered only when the record run covers it. Volumes are
  // uptime-free (D63), so the BOX "rate" is volume / days in month, not a calendar rate.
  const box = overlay?.box ?? null;
  const boxCovered = box != null && isForecastClass(box.coverage); // validated or provisional tier (D105)
  const boxProv = box?.coverage === "covered_provisional";
  const src: WellSource = boxCovered ? wellSource : "novi";
  const boxStream = box?.streams[phase]; // water since sql/62 (its own tier: box.water_tier)
  const boxWaterProv = phase === "water" && box?.water_tier === "provisional";
  if (overlay && src !== "novi" && boxStream) {
    const label = `${overlay.name} (BOX run ${box?.run_id})`;
    series.push(mode === "rate"
      ? { label, color: "#2563eb", xs: yrs(boxStream.rate_day), ys: boxStream.rate, width: 2 }
      : { label, color: "#2563eb", xs: yrs(boxStream.cum_day), ys: boxStream.cum, width: 2 });
  }
  if (overlay && src !== "box") {
    const fcDays = overlay.forecast.ip_day, fcVals = overlay.forecast[phase];
    const tDays = overlay.arps_tail.ip_day, tVals = overlay.arps_tail[phase];
    if (mode === "rate") {
      series.push({ label: overlay.name, color: "#111827", xs: yrs(fcDays), ys: fcVals, width: 2 });
      series.push({ label: `${overlay.name} (Arps)`, color: "#111827", xs: yrs(tDays), ys: tVals, dashed: true, width: 1.5 });
    } else {
      const fcCum = cumsum(fcVals);
      const base = fcCum.length ? fcCum[fcCum.length - 1] : 0;
      let acc = base;
      const tCum = tVals.map((v) => (acc += v * STEP_DAYS));
      series.push({ label: overlay.name, color: "#111827", xs: yrs(fcDays), ys: fcCum, width: 2 });
      series.push({ label: `${overlay.name} (Arps)`, color: "#111827", xs: yrs(tDays), ys: tCum, dashed: true, width: 1.5 });
    }
  }

  const baseUnit = phase === "gas" ? (mode === "rate" ? "MCFD" : "MCF")
    : (mode === "rate" ? (phase === "oil" ? "BOPD" : "BWPD") : "BBL");
  const unit = prod && agg === "avg" ? `${baseUnit} per 1,000 ft, mean` : baseUnit;

  return (
    <div className="prod-view">
      <div className="prod-head">
        <strong>
          Production —{" "}
          {prod ? `AOI: BOX run ${prod.box_run.run_id} ${agg === "avg" ? "mean per 1,000 ft" : "field total"}` : ""}
          {prod && overlay ? " · " : ""}
          {overlay ? `well: ${src === "novi" ? "Novi" : src === "box" ? "BOX" : "BOX vs Novi"}` : ""}
        </strong>
        <div className="seg sm">
          {PHASES.map((p) => (
            <button key={p} className={phase === p ? "active" : ""}
              onClick={() => st.getState().setProductionPhase(p)}>{p}</button>
          ))}
        </div>
        <div className="seg sm">
          <button className={mode === "rate" ? "active" : ""} onClick={() => st.getState().setChartMode("rate")}>rate</button>
          <button className={mode === "cum" ? "active" : ""} onClick={() => st.getState().setChartMode("cum")}>cum</button>
        </div>
        <div className="seg sm">
          <button className={agg === "avg" ? "active" : ""} onClick={() => st.getState().setAggMode("avg")}>mean / 1,000 ft</button>
          <button className={agg === "sum" ? "active" : ""} onClick={() => st.getState().setAggMode("sum")}>sum</button>
        </div>
        {prod && (stale || screenStale) && (
          <button className="link" onClick={() => void load()}>↻ {stale ? "culls" : "screen"} changed — reload</button>
        )}
        {overlay && boxCovered && (
          <div className="seg sm">
            {(["novi", "box", "both"] as WellSource[]).map((s) => (
              <button key={s} className={src === s ? "active" : ""}
                onClick={() => st.getState().setWellSource(s)}>{s === "novi" ? "Novi" : s === "box" ? "BOX" : "both"}</button>
            ))}
          </div>
        )}
        {overlay && (
          <span className="well-tag">
            ● {overlay.name}
            {overlay.has_forecast === false ? " (PDP — no Novi forecast)" : ""}
            {box && !boxCovered ? ` · BOX: not covered (${COVERAGE_LABELS[box.coverage] ?? box.coverage})` : ""}
            {boxCovered && src !== "novi" && box.eur_per_kft.oil != null
              ? ` · BOX oil ${Math.round(box.eur_per_kft.oil).toLocaleString()} bbl/kft` : ""}
            {boxProv && (
              <> <span className="box-prov-badge" title={(box.flags ?? []).join("\n")}>BOX PROVISIONAL</span></>
            )}
            <button className="link" onClick={() => st.getState().setWellOverlay(null)}>clear</button>
          </span>
        )}
      </div>

      {overlay && boxCovered && src !== "novi" && (
        <div className="count" style={{ margin: "0 0 4px" }}>
          {phase === "water"
            ? (box.streams.water
              ? <>BOX water = WOR vs cumulative oil fitted on MEASURED-water analogs{box.water_source === "calculated_fallback" ? " (none within 50 mi: calculated-water fallback)" : ""}, applied to the
                  raw box_v2 oil (before any haircut), uptime-free; production through {box.data_through}.
                  {" "}{boxWaterProv
                    ? <span className="box-prov-badge">WATER PROVISIONAL</span>
                    : <span>Water tier: validated (WCA / BS2_S holdout, D110).</span>}</>
              : "This BOX run carries no water.")
            : `BOX = analog cohort P50 × walk-forward haircut, uptime-free (apply F(k) or a downtime factor, never both); production through ${box.data_through}. Novi = Novi's own forecast.`}
        </div>
      )}
      {prod || overlay ? (
        <div className="prod-chart" ref={chartRef}>
          {chartSize.width > 0 && (
            <LineChart
              series={series}
              width={Math.max(240, chartSize.width)}
              height={Math.max(160, chartSize.height - 16)} // the x-zoom slider row sits under the svg
              xlabel="years on production"
              ylabel={`${mode === "rate" ? "rate" : "cum"} (${unit})`}
            />
          )}
        </div>
      ) : (
        <div className="prod-load">
          <button disabled={loading} onClick={() => void load()}>
            {loading ? "Loading… (a few seconds)" : "Load BOX profiles (by bench)"}
          </button>
          <span className="count">or click a stick on the map to overlay a single well (BOX vs Novi)</span>
        </div>
      )}
    </div>
  );
}
