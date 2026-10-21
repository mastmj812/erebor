import { useEffect, useState } from "react";

import { MAP_COVERAGE_LABELS, MAP_COVERAGE_ORDER, deckLabel } from "../api/boxMap";
import {
  HG_METRICS,
  PROX_GROUP_LABELS,
  fetchBoxMeta,
  fetchFacets,
  fetchHighgradePads,
  fmtHgValue,
  hgAggLabel,
  hgMetricLabel,
  isMoneyMetric,
  isMedianMetric,
  isPerKftMetric,
  type BoxMeta,
  type HighgradeAgg,
  type HighgradeFacets,
  type HighgradeFilters,
  type HighgradeMetric,
  type ProxGroup,
} from "../api/highgrade";
import { colorForBlueox } from "../map/formations";
import { useMapStore, type HighgradeResult, type OverlayKey } from "../store";
import { BoxProximityNote } from "./BoxWorkup";
import { ChipGroup } from "./ChipGroup";

// Highgrade on BOX (overhaul step 5). Novi supplies the stick geometry and the DSU polygons
// only (Michael, 2026-10-21): no Novi tag, tier, forecast or NPV is screened or shown here.

// map overlays surfaced on the Highgrade tab (same toggle mechanism as the Map tab's
// Controls panel; the layers are mode-agnostic so they render in Highgrade mode too).
const HG_OVERLAYS: { key: OverlayKey; label: string }[] = [
  { key: "blocks", label: "Blocks (TX/NM grid)" },
  { key: "sections", label: "Sections (numbered, z≥11)" },
];

// Range filters, keyed by the backend whitelist (highgrade.BOX_RANGES / ECON_RANGES). The
// backend takes STORED units; `scale` converts the entry (per-ft EUR is stored per 1,000 ft).
// A bound acts on forecast locations only: one without a BOX forecast stays in the screen,
// counted under its class — never dropped, never a zero (D67).
const KEEP_HINT = "Bounds act on BOX-forecast locations only; a location without a forecast stays in the screen, counted under its class.";
const RANGE_FIELDS: { col: string; label: string; scale?: number; econ?: boolean; hint?: string }[] = [
  { col: "oil_eur_per_kft", label: "Oil EUR (bbl/ft)", scale: 1000 },
  { col: "gas_eur_per_kft", label: "Gas EUR (mcf/ft)", scale: 1000 },
  { col: "water_eur_per_kft", label: "Water EUR (bbl/ft)", scale: 1000 },
  { col: "oil_eur", label: "Oil EUR (bbl)" },
  { col: "prox_factor", label: "PDP-proximity oil factor (×)",
    hint: "D113 oil factor: 1 = as-is (unexposed / single parent), 0.75–0.94 = multi-parent haircut." },
  { col: "lateral_ft", label: "BOX lateral (ft)" },
  { col: "econ_pv10", label: "PV10 ($MM)", econ: true },
  { col: "econ_pv20", label: "PV20 ($MM)", econ: true },
  { col: "econ_irr", label: "IRR (%)", econ: true },
  { col: "econ_be_wti", label: "Breakeven WTI @ PV20 ($/bbl)", econ: true },
  { col: "econ_capex", label: "Capex ($MM)", econ: true },
];
const ECON_RANGE_HINT = "A forecast location without a priced value fails an econ bound; not-covered locations stay, counted.";

type RangeMap = Record<string, [number | null, number | null]>;

// PDP-proximity screen (D112–D116): empty = all. An explicit outcome screen, so it drops every
// location outside the selection — including those BOX never measured (outside the extent, …).
const PROX_OPTIONS: ProxGroup[] = ["as_is", "haircut", "no_precedent"];
const PROX_SHORT: Record<ProxGroup, string> = { as_is: "as-is", haircut: "haircut", no_precedent: "no precedent" };
const PROX_HINT = "as-is = unexposed or single parent (BOX unchanged) · haircut = 2+ depleted parents with drilled precedent, oil × 0.75–0.94 (D113) · no precedent = no forecast (D114). Selecting any drops the locations BOX never measured (outside the extent, emerging, …).";

export function HighgradePanel() {
  const basin = useMapStore((s) => s.basin);
  const setBasin = useMapStore((s) => s.setBasin);
  const highgrade = useMapStore((s) => s.highgrade);
  const setHighgrade = useMapStore((s) => s.setHighgrade);
  const setHighgradeFilters = useMapStore((s) => s.setHighgradeFilters);
  const closeHgGunbarrel = useMapStore((s) => s.closeHgGunbarrel);
  const overlays = useMapStore((s) => s.overlays);
  const toggleOverlay = useMapStore((s) => s.toggleOverlay);
  const boxMeta = useMapStore((s) => s.boxMeta);
  const setBoxMeta = useMapStore((s) => s.setBoxMeta);
  // the econ deck is shared with the Map tab (one deck choice across the app)
  const mapDeck = useMapStore((s) => s.mapDeck);
  const setMapDeck = useMapStore((s) => s.setMapDeck);

  const [facets, setFacets] = useState<HighgradeFacets | null>(null);
  const [benches, setBenches] = useState<string[]>([]);
  const [ranges, setRanges] = useState<RangeMap>({});
  const [prox, setProx] = useState<ProxGroup[]>([]);
  const [metric, setMetric] = useState<HighgradeMetric>("oil_eur_per_kft");
  const [agg, setAgg] = useState<HighgradeAgg>("sum");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = boxMeta?.basin === basin ? boxMeta : null;
  const deck = mapDeck ?? meta?.default_deck ?? null;
  const decks = [...new Map((meta?.decks ?? []).map((d) => [d.deck_id, d])).values()];
  const priced = meta != null && meta.econ_status !== "not_yet_priced" && decks.length > 0;
  const noForecast = meta != null && (meta.forecast_count ?? 0) === 0;

  // Reset the form on basin change (filters are basin-specific).
  useEffect(() => {
    setBenches([]);
    setRanges({});
    setProx([]);
  }, [basin]);

  // BOX record run + provenance + Steven's priced decks, once per basin (the Map tab may
  // have loaded it already).
  useEffect(() => {
    if (boxMeta?.basin === basin) return;
    let live = true;
    fetchBoxMeta(basin)
      .then((m) => { if (live) setBoxMeta(m); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [basin, boxMeta, setBoxMeta]);

  // (Re)load facets on basin / deck change: bench list + the range placeholders.
  useEffect(() => {
    let live = true;
    setFacets(null);
    fetchFacets(basin, deck)
      .then((f) => { if (live) setFacets(f); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [basin, deck]);

  // An econ metric without a priced run falls back to the default; per acre is $-only.
  useEffect(() => {
    if (meta && !priced && HG_METRICS.find((m) => m.value === metric)?.econ) setMetric("oil_eur_per_kft");
  }, [meta, priced, metric]);
  useEffect(() => {
    if (!isMoneyMetric(metric)) setAgg((a) => (a === "per_acre" ? "sum" : a));
  }, [metric]);

  const setRange = (col: string, idx: 0 | 1, raw: string, scale = 1) =>
    setRanges((r) => {
      const cur = r[col] ?? [null, null];
      const next: [number | null, number | null] = [...cur] as [number | null, number | null];
      next[idx] = raw === "" ? null : Number(raw) * scale;
      const out = { ...r };
      if (next[0] == null && next[1] == null) delete out[col];
      else out[col] = next;
      return out;
    });

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const filters: HighgradeFilters = {};
      if (benches.length) filters.formation_blueox = benches;
      if (prox.length) filters.prox = prox;
      const rangeEntries = Object.entries(ranges)
        .filter(([col, [lo, hi]]) => (lo != null || hi != null) && (priced || !col.startsWith("econ_")));
      if (rangeEntries.length) filters.ranges = Object.fromEntries(rangeEntries);
      const res = await fetchHighgradePads({ basin, filters, metric, agg, deck });
      setHighgrade(res);
      // Record the applied screen so a per-DSU gunbarrel can grey off-screen locations.
      setHighgradeFilters(filters);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setBenches([]);
    setRanges({});
    setProx([]);
    setHighgrade(null);
    setHighgradeFilters(null);
    closeHgGunbarrel();
  };

  const showAgg = !isPerKftMetric(metric) && !isMedianMetric(metric) && metric !== "well_count";
  const metricOptions = HG_METRICS.filter((m) => priced || !m.econ);
  const econMetric = HG_METRICS.find((m) => m.value === metric)?.econ ?? false;

  return (
    <div className="panel highgrade">
      <div className="seg">
        <button className={basin === "delaware" ? "active" : ""} onClick={() => setBasin("delaware")}>Delaware</button>
        <button className={basin === "midland" ? "active" : ""} onClick={() => setBasin("midland")}>Midland</button>
      </div>
      <div className="count">
        Screen the remaining stick locations on BOX → highlight target DSUs. Locations = every Novi stick (geometry
        only; Novi's PUD / RES tags are not used) that our reconciliation did not match to a producing well.
      </div>
      {noForecast && (
        <div className="caveat">
          BOX does not forecast {basin === "midland" ? "Midland" : "this basin"} yet: no location here carries a BOX
          forecast, so every pad is drawn grey and counted by class. This lights up when a BOX record run covers the basin.
        </div>
      )}

      <BoxRunNote meta={meta} />

      <h3>Metric (per pad)</h3>
      <div className="row" style={{ marginBottom: 6 }}>
        <select value={metric} onChange={(e) => setMetric(e.target.value as HighgradeMetric)} style={{ flex: 1, fontSize: 12 }}>
          {metricOptions.map((m) => <option key={m.value} value={m.value}>{m.label}{m.econ ? " (Steven)" : ""}</option>)}
        </select>
      </div>
      {priced && (
        <div className="row" style={{ marginBottom: 6 }}>
          <select value={deck ?? ""} onChange={(e) => setMapDeck(e.target.value || null)} style={{ flex: 1, fontSize: 12 }}
            title="Steven's price deck — shared with the Map tab; applies to econ metrics and econ bounds">
            {decks.map((d) => <option key={d.deck_id} value={d.deck_id}>{deckLabel(d.deck_id, d.wti, d.hh)}</option>)}
          </select>
        </div>
      )}
      <EconNote meta={meta} priced={priced} deck={deck} econMetric={econMetric} />
      {isPerKftMetric(metric) && (
        <div className="count" style={{ margin: "0 0 10px" }}>Pad value = lateral-weighted: Σ EUR ÷ Σ lateral (the lateral BOX used).</div>
      )}
      {isMedianMetric(metric) && (
        <div className="count" style={{ margin: "0 0 10px" }}>Pad value = median over its priced locations (a rate does not add up).</div>
      )}
      {showAgg && (
        <div className="seg sm" style={{ marginBottom: 10 }}>
          <button className={agg === "sum" ? "active" : ""} onClick={() => setAgg("sum")}>Sum</button>
          <button className={agg === "avg" ? "active" : ""} onClick={() => setAgg("avg")}>Avg / location</button>
          {isMoneyMetric(metric) && (
            <button className={agg === "per_acre" ? "active" : ""} onClick={() => setAgg("per_acre")}>Per acre</button>
          )}
        </div>
      )}

      <h3 style={{ marginTop: 4 }}>Overlays</h3>
      {HG_OVERLAYS.map(({ key, label }) => (
        <div className="row" key={key}>
          <input id={`hg-ov-${key}`} type="checkbox" checked={overlays[key]} onChange={() => toggleOverlay(key)} />
          <label htmlFor={`hg-ov-${key}`}>{label}</label>
        </div>
      ))}

      {!facets && !error && <div className="count">Loading filters…</div>}

      {facets && (
        <>
          <ChipGroup
            label="Bench (Blue Ox)"
            options={facets.categorical.formation_blueox}
            selected={benches}
            onToggle={(v) => setBenches((b) => (b.includes(v) ? b.filter((x) => x !== v) : [...b, v]))}
            swatch={(code) => colorForBlueox(basin, code)}
          />

          <ChipGroup
            label="BOX PDP proximity"
            hint={PROX_HINT}
            options={PROX_OPTIONS}
            selected={prox}
            onToggle={(v) => setProx((p) => (p.includes(v as ProxGroup) ? p.filter((x) => x !== v) : [...p, v as ProxGroup]))}
            labelOf={(v) => PROX_SHORT[v as ProxGroup] ?? v}
          />

          <h3 style={{ marginTop: 10 }}>Ranges</h3>
          <div className="count" style={{ margin: "0 0 4px" }}>{KEEP_HINT}</div>
          {RANGE_FIELDS.filter((f) => !f.econ || priced).map(({ col, label, scale, econ, hint }) => (
            <RangeRow
              key={col}
              label={label}
              hint={econ ? ECON_RANGE_HINT : hint}
              bounds={facets.numeric[col]}
              scale={scale ?? 1}
              value={ranges[col] ?? [null, null]}
              onChange={(idx, raw) => setRange(col, idx, raw, scale ?? 1)}
            />
          ))}

          <div className="seg" style={{ marginTop: 12 }}>
            <button className="active" disabled={busy} onClick={() => void apply()}>
              {busy ? "Screening…" : "Apply"}
            </button>
            <button disabled={busy} onClick={reset}>Reset</button>
          </div>
        </>
      )}

      {error && <div className="caveat" style={{ color: "#991b1b", background: "#fef2f2", borderColor: "#fecaca" }}>{error}</div>}

      {highgrade && <ResultSummary hg={highgrade} />}
    </div>
  );
}

function ResultSummary({ hg }: { hg: HighgradeResult }) {
  return (
    <div className="hg-summary">
      <div><strong>{hg.pad_count.toLocaleString()}</strong> pads · <strong>{hg.well_count.toLocaleString()}</strong> locations</div>
      <div className="count" style={{ margin: "2px 0 0" }}>
        BOX run {hg.box_run.run_id} · {hgMetricLabel(hg.metric)} ({hgAggLabel(hg.agg)}):{" "}
        {fmtHgValue(hg.value_min, hg.metric, hg.agg)} … {fmtHgValue(hg.value_max, hg.metric, hg.agg)}
      </div>
      {hg.econ && (
        <div className="count" style={{ margin: "2px 0 0" }}>
          Steven's econ, {deckLabel(hg.econ.deck_id, hg.econ.wti, hg.econ.hh)} · {hg.econ.assumption_set_id} — display only (D13).
        </div>
      )}
      <CoverageSummary hg={hg} />
      <ProximitySummary pc={hg.proximity_counts} />
      {hg.pads_missing_geom > 0 && (
        <div className="count" style={{ margin: "2px 0 0", color: "#92400e" }}>
          {hg.pads_missing_geom.toLocaleString()} matching pads have no polygon (not drawn)
        </div>
      )}
      {hg.wells_without_pad > 0 && (
        <div className="count" style={{ margin: "2px 0 0", color: "#92400e" }}>
          {hg.wells_without_pad.toLocaleString()} screened locations have no pad assignment (not drawn)
          {hg.pad_count === 0 ? " — no pads for this basin" : ""}
        </div>
      )}
      {hg.pad_count > 0 && (
        <div className="count" style={{ margin: "2px 0 0" }}>
          Pad outlines = Novi 2026Q3 DSU polygons
          {hg.pads_hull > 0 ? `; ${hg.pads_hull.toLocaleString()} pads (strays of a reused name, or no polygon) are the member-stick hull + 330 ft` : ""}
          {hg.names_split > 0 ? `; ${hg.names_split.toLocaleString()} names split into [k/n] parts` : ""}. Stacked-bench DSUs overlap.
        </div>
      )}
    </div>
  );
}

function RangeRow({
  label, hint, bounds, scale, value, onChange,
}: {
  label: string;
  hint?: string;
  bounds: { min: number | null; max: number | null } | undefined;
  scale: number;
  value: [number | null, number | null];
  onChange: (idx: 0 | 1, raw: string) => void;
}) {
  const ph = (v: number | null) => (v == null ? "" : trim(v / scale));
  const show = (v: number | null) => (v == null ? "" : String(+(v / scale).toPrecision(6)));
  return (
    <div className="hg-range">
      <div className="hg-range-label" title={hint}>{label}{hint ? " ⓘ" : ""}</div>
      <div className="hg-range-inputs">
        <input
          type="number" inputMode="decimal" placeholder={`min ${ph(bounds?.min ?? null)}`}
          value={show(value[0])} onChange={(e) => onChange(0, e.target.value)}
        />
        <span>–</span>
        <input
          type="number" inputMode="decimal" placeholder={`max ${ph(bounds?.max ?? null)}`}
          value={show(value[1])} onChange={(e) => onChange(1, e.target.value)}
        />
      </div>
    </div>
  );
}

function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

// BOX provenance + the method statement every BOX number carries (D59 condition 3,
// D62/D63; water D107-D110; proximity D112-D116).
function BoxRunNote({ meta }: { meta: BoxMeta | null }) {
  if (!meta) return <div className="count">Loading BOX record run…</div>;
  const r = meta.run;
  const oil = meta.disclosure.filter((d) => d.stream === "oil");
  const d92 = meta.haircut_method.method != null;
  const tail = meta.haircut_method.tail?.oil;
  const groups = meta.groups ?? [];
  const others = groups.filter((g) => g.group !== "WCA");
  const forms = (gs: typeof others) => gs.map((g) => g.formations.join(" / ")).join(", ");
  const validated = groups.filter((g) => g.tier !== "provisional");
  const provisional = groups.filter((g) => g.tier === "provisional");
  const waterOk = groups.filter((g) => g.water?.tier === "validated").map((g) => g.formations.join(" / "));
  const hasWater = groups.some((g) => g.water);
  return (
    <div className="caveat" style={{ margin: "4px 0 10px" }}>
      <div>
        <strong>BOX run {r.run_id}</strong> (record) · Novi {r.report_version} sticks · production through {r.data_through} ·
        code {r.code_sha.slice(0, 7)}
      </div>
      <div style={{ marginTop: 4 }}>
        Analog-workup forecasts (D57): deal-intake analog cohort <strong>P50</strong> per 1,000 ft × lateral, then a
        stated walk-forward haircut. Uptime-free (apply F(k) or a downtime factor, never both); EUR = raw 50-yr technical
        integral.{" "}
        {hasWater
          ? <>Water = WOR vs cumulative oil on MEASURED-water analogs, applied to the raw box_v2 oil (no haircut, D107 / D108);
              water tier validated on {waterOk.join(", ") || "none"}, provisional elsewhere (D110).</>
          : "Oil + gas only on this run."} Covers Delaware {forms(validated) || "WCA_1 / WCA_2"}{" "}
        (validated)
        {provisional.length > 0 && <>, plus <span className="box-prov-badge">PROVISIONAL</span> {forms(provisional)} (D105: raw
          box_v2, never out-of-time validated or failed its one-time holdout — counted apart from validated)</>}{" "}
        inside their extents; every other location is shown as not covered, never zero.
      </div>
      <div style={{ marginTop: 4 }}>
        Offset depletion enters BOX two ways: through the named analogs, and for multi-parent PUDs as an explicit oil
        haircut (D113). Unprecedented configurations get no forecast (D114).
      </div>
      <table className="hg-box-tbl">
        <thead><tr><th>WCA oil</th><th>measured bias</th><th>{d92 ? "D62 target" : "haircut"}</th>{d92 && <th>realised (D92)</th>}<th>held-out after</th></tr></thead>
        <tbody>
          {oil.map((d) => (
            <tr key={d.horizon}>
              <td>{d.horizon}</td><td>{pct(d.measured_bias)}</td><td>×{d.haircut.toFixed(3)}</td>
              {d92 && <td>×{d.realised_median?.toFixed(3) ?? "—"}</td>}
              <td>{pct(d.holdout_bias_after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="count" style={{ margin: "2px 0 0" }}>
        Bias = actual ÷ forecast − 1 (negative = method forecast high).{" "}
        {d92
          ? `D92: the D62 targets are applied to the rate as a smooth factor (a + b·ln k, fitted per PUD), so a rate never rises after its peak; realised = median cumulative factor across covered PUDs. The rate factor holds at ×${tail?.toFixed(3) ?? "—"} after month 48 (50-yr EUR).`
          : "The cum-48 factor holds for the 50-yr EUR (D62)."}{" "}
        Each pad workup shows its own bench group's figures.
      </div>
      {others.length > 0 && (
        <table className="hg-box-tbl">
          <thead><tr><th>oil, other groups</th>{oil.map((d) => <th key={d.horizon}>{d.horizon}</th>)}</tr></thead>
          <tbody>
            {others.map((g) => {
              // a holdout-FAILED bench never shows its pooled (disclosed) figure without the holdout one (D105)
              const fail = g.tier === "provisional" && !!g.holdout_failed;
              return (
                <tr key={g.group}>
                  <td>
                    {g.group === "WCXY_WCA1" ? "WCXY" : g.group} ({g.spec}){" "}
                    {g.tier === "provisional" && <span className={`box-prov-badge${fail ? " fail" : ""}`}>{fail ? "PROV · HOLDOUT FAIL" : "PROV"}</span>}
                    : haircut · disclosed bias{fail ? " · holdout" : ""}
                  </td>
                  {g.disclosure.filter((d) => d.stream === "oil").map((d) => (
                    <td key={d.horizon}>
                      ×{d.haircut.toFixed(3)} · {pct(d.disclosed_bias ?? null)}
                      {fail && (d.disclosed_bias != null || d.holdout_bias_after != null)
                        ? ` · ${d.holdout_bias_after == null ? "no holdout" : pct(d.holdout_bias_after)}` : ""}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {meta.proximity && <BoxProximityNote p={meta.proximity} />}
      {meta.stale && (
        <div style={{ color: "#991b1b", marginTop: 4 }}>
          The warehouse holds Novi {meta.intel_report_versions.join(", ")}; this run keys on {r.report_version} sticks —
          locations read "not screened" until the quarterly BOX refresh.
        </div>
      )}
    </div>
  );
}

// Steven's econ on the record run: provenance, or "not yet priced" (overhaul decision 2).
function EconNote({ meta, priced, deck, econMetric }: {
  meta: BoxMeta | null; priced: boolean; deck: string | null; econMetric: boolean;
}) {
  if (!meta) return null;
  if (!priced) {
    return (
      <div className="count" style={{ margin: "0 0 8px" }}>
        Econ: not yet priced on BOX run {meta.run.run_id} — PV / IRR / breakeven metrics and bounds appear when Steven pushes it.
      </div>
    );
  }
  const d = meta.decks.find((x) => x.deck_id === deck);
  return (
    <div className="count" style={{ margin: "0 0 8px" }}>
      {econMetric ? "" : "Econ bounds use this deck. "}
      Steven's economics on BOX run {meta.run.run_id} volumes — display only, erebor computes no economics (D13).
      {d ? ` ${deckLabel(d.deck_id, d.wti, d.hh)} · ${d.assumption_set_id} · downtime: ${d.downtime_basis} · built ${d.built_at?.slice(0, 10) ?? "—"}${d.pushed_at ? ` · pushed ${d.pushed_at.slice(0, 10)}` : ""}.` : ""}
      {" "}Unpriced forecast locations are counted, not zeroed.
    </div>
  );
}

function CoverageSummary({ hg }: { hg: HighgradeResult }) {
  const counts = hg.coverage_counts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rows = MAP_COVERAGE_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  const vt = hg.valued_by_tier;
  // validated and provisional (D105) stay separate: the value carries both, so say how many of each
  const split = ` (${vt.validated.toLocaleString()} validated · ${vt.provisional.toLocaleString()} PROVISIONAL)`;
  const valueNote =
    hg.metric === "well_count" ? "The count includes every screened location."
    : hg.econ ? `${hg.valued_count.toLocaleString()} priced locations${split} carry the value; the rest are excluded, not zeroed.`
    : `${hg.valued_count.toLocaleString()} BOX-forecast locations${split} carry the value; the rest are excluded, not zeroed.`;
  return (
    <div style={{ margin: "6px 0 0" }}>
      <div className="count" style={{ margin: 0 }}>BOX coverage of the {total.toLocaleString()} screened locations:</div>
      <table className="hg-box-tbl">
        <tbody>
          {rows.map((k) => (
            <tr key={k} className={k === "covered" || k === "covered_provisional" ? "" : "nc"}>
              <td>{k === "covered_provisional"
                ? <><span className="box-prov-badge">PROVISIONAL</span> {MAP_COVERAGE_LABELS[k]}</>
                : MAP_COVERAGE_LABELS[k] ?? k}</td>
              <td style={{ textAlign: "right" }}>{(counts[k] ?? 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="count" style={{ margin: "2px 0 0" }}>{valueNote}</div>
      {hg.pads_unvalued > 0 && (
        <div className="count" style={{ margin: "2px 0 0" }}>
          {hg.pads_unvalued.toLocaleString()} pads have no {hg.econ ? "priced" : "BOX-forecast"} location — drawn grey.
        </div>
      )}
    </div>
  );
}

// Screen-wide PDP-proximity outcomes (D112–D116): BOX's EUR already carries the oil factor.
function ProximitySummary({ pc }: { pc: HighgradeResult["proximity_counts"] }) {
  const n = pc.as_is + pc.haircut + pc.no_precedent;
  if (n === 0) return null;
  const range = pc.factor_min != null && pc.factor_max != null ? ` (oil ×${pc.factor_min.toFixed(3)}–×${pc.factor_max.toFixed(3)})` : "";
  return (
    <div style={{ margin: "6px 0 0" }}>
      <div className="count" style={{ margin: 0 }}>PDP proximity of the {n.toLocaleString()} locations BOX measured:</div>
      <table className="hg-box-tbl">
        <tbody>
          <tr><td>{PROX_GROUP_LABELS.as_is}</td><td style={{ textAlign: "right" }}>{pc.as_is.toLocaleString()}</td></tr>
          <tr><td>{PROX_GROUP_LABELS.haircut}{range}</td><td style={{ textAlign: "right" }}>{pc.haircut.toLocaleString()}</td></tr>
          <tr className="nc"><td>{PROX_GROUP_LABELS.no_precedent}</td><td style={{ textAlign: "right" }}>{pc.no_precedent.toLocaleString()}</td></tr>
        </tbody>
      </table>
      <div className="count" style={{ margin: "2px 0 0" }}>
        BOX EUR already carries the oil factor (gas / water untouched). The haircut is validated with exception and,
        measured on operator-selected infills, an upper bound for undrilled locations — see the BOX note above.
      </div>
    </div>
  );
}

function trim(v: number): string {
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toPrecision(3);
}
