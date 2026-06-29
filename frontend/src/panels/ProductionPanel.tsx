import { fetchProductionAggregate } from "../api/production";
import { colorForBlueox } from "../map/formations";
import { useMapStore, type Phase } from "../store";
import { LineChart, type Series } from "./LineChart";

const PHASES: Phase[] = ["oil", "gas", "water"];
const STEP_DAYS = 30; // forecast cadence

function cumsum(vals: number[]): number[] {
  let acc = 0;
  return vals.map((v) => (acc += v * STEP_DAYS));
}
const yrs = (days: number[]) => days.map((d) => d / 365);

export function ProductionView({ width, height }: { width?: number; height?: number }) {
  const aoi = useMapStore((s) => s.aoi);
  const basin = useMapStore((s) => s.basin);
  const rule = useMapStore((s) => s.selectionRule);
  const excluded = useMapStore((s) => s.excludedFormations);
  const prod = useMapStore((s) => s.production);
  const loading = useMapStore((s) => s.productionLoading);
  const phase = useMapStore((s) => s.productionPhase);
  const mode = useMapStore((s) => s.chartMode);
  const agg = useMapStore((s) => s.aggMode);
  const overlay = useMapStore((s) => s.wellOverlay);
  const sel = useMapStore((s) => s.selection);
  const excludedSticks = useMapStore((s) => s.excludedSticks);
  const stale = useMapStore((s) => s.productionStale);
  const st = useMapStore;

  const load = async () => {
    if (!aoi) return;
    st.getState().setProductionLoading(true);
    try {
      // Map culled stick_ids -> well names so the backend drops them from the curves.
      const byId = new Map((sel?.sticks ?? []).map((s) => [s.stick_id, s.unique_id]));
      const exclude = excludedSticks
        .map((id) => byId.get(id))
        .filter((n): n is string => !!n);
      const p = await fetchProductionAggregate(aoi, basin, rule, exclude);
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
    for (const f of prod.formations) {
      if (exSet.has(f.formation)) continue;
      // Avg = per-well type curve (sum / well_count); Sum = total field rate.
      const div = agg === "avg" ? f.well_count || 1 : 1;
      const raw = f[phase].map((v) => v / div);
      series.push({
        label: f.formation,
        color: colorForBlueox(basin, f.formation),
        xs: yrs(prod.ip_days),
        ys: mode === "rate" ? raw : cumsum(raw),
      });
    }
  }
  if (overlay) {
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
  const unit = agg === "avg" ? `${baseUnit}/well` : baseUnit;

  return (
    <>
      <div className="prod-head">
        <strong>Production — Novi forecast</strong>
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
          <button className={agg === "avg" ? "active" : ""} onClick={() => st.getState().setAggMode("avg")}>avg/well</button>
          <button className={agg === "sum" ? "active" : ""} onClick={() => st.getState().setAggMode("sum")}>sum</button>
        </div>
        {prod && stale && (
          <button className="link" onClick={() => void load()}>↻ culls changed — reload</button>
        )}
        {overlay && (
          <span className="well-tag">
            ● {overlay.name}
            {overlay.has_forecast === false ? " (PDP — no Novi forecast)" : ""}
            <button className="link" onClick={() => st.getState().setWellOverlay(null)}>clear</button>
          </span>
        )}
      </div>

      {prod || overlay ? (
        <LineChart
          series={series}
          width={Math.max(360, (width ?? 820) - 8)}
          height={Math.max(200, (height ?? 380) - 48)}
          xlabel="years on production"
          ylabel={`${mode === "rate" ? "rate" : "cum"} (${unit})`}
        />
      ) : (
        <div className="prod-load">
          <button disabled={loading} onClick={() => void load()}>
            {loading ? "Loading… (a few seconds)" : "Load production profiles"}
          </button>
          <span className="count">or click a stick on the map to overlay a single well</span>
        </div>
      )}
    </>
  );
}
