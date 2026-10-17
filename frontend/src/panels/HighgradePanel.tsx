import { useEffect, useState } from "react";

import {
  COVERAGE_LABELS,
  fetchBoxMeta,
  fetchFacets,
  fetchHighgradePads,
  isMoneyMetric,
  isPerKftMetric,
  type BoxMeta,
  type CategoricalField,
  type EconDeck,
  type ForecastSource,
  type HighgradeAgg,
  type HighgradeFacets,
  type HighgradeFilters,
  type HighgradeMetric,
} from "../api/highgrade";
import { colorForBlueox } from "../map/formations";
import { useMapStore, type OverlayKey } from "../store";
import { ChipGroup } from "./ChipGroup";

// Exported: the legend and the gunbarrel label from the same table.
export const METRICS: { value: HighgradeMetric; label: string; sources: ForecastSource[] }[] = [
  { value: "npv5", label: "NPV @ 5%", sources: ["novi"] },
  { value: "npv10", label: "NPV @ 10%", sources: ["novi"] },
  { value: "npv15", label: "NPV @ 15%", sources: ["novi"] },
  { value: "npv20", label: "NPV @ 20%", sources: ["novi"] },
  { value: "npv25", label: "NPV @ 25%", sources: ["novi"] },
  { value: "pv5", label: "PV @ 5%", sources: ["novi"] },
  { value: "pv10", label: "PV @ 10%", sources: ["novi"] },
  { value: "pv15", label: "PV @ 15%", sources: ["novi"] },
  { value: "pv20", label: "PV @ 20%", sources: ["novi"] },
  { value: "pv25", label: "PV @ 25%", sources: ["novi"] },
  { value: "oil_eur", label: "Oil EUR", sources: ["novi", "box"] },
  { value: "gas_eur", label: "Gas EUR", sources: ["novi", "box"] },
  { value: "oil_eur_per_kft", label: "Oil EUR / 1,000 ft", sources: ["novi", "box"] },
  { value: "gas_eur_per_kft", label: "Gas EUR / 1,000 ft", sources: ["novi", "box"] },
  // Steven's box_econ values on BOX volumes, one named deck (display-only, D13)
  { value: "box_pv0", label: "Steven PV0", sources: ["box"] },
  { value: "box_pv10", label: "Steven PV10", sources: ["box"] },
  { value: "box_pv15", label: "Steven PV15", sources: ["box"] },
  { value: "box_pv20", label: "Steven PV20", sources: ["box"] },
  { value: "box_pv25", label: "Steven PV25", sources: ["box"] },
  { value: "box_pv30", label: "Steven PV30", sources: ["box"] },
  { value: "well_count", label: "Well count", sources: ["novi", "box"] },
];
const DEFAULT_METRIC: Record<ForecastSource, HighgradeMetric> = { novi: "npv25", box: "oil_eur_per_kft" };
const DECK_SEP = "\u001f"; // deck_id / assumption_set_id separator in the deck <select> value

// tier multi-selects (4 chips each, Tier-1..4)
const TIER_FIELDS: { field: CategoricalField; label: string; hint?: string }[] = [
  { field: "rqt", label: "Rock quality tier" },
  { field: "spacing_t", label: "Spacing tier" },
  { field: "deplet_t", label: "Depletion tier" },
  { field: "complet_t", label: "Completion tier" },
];

// map overlays surfaced on the Highgrade tab (same toggle mechanism as the Map tab's
// Controls panel; the layers are mode-agnostic so they render in Highgrade mode too).
const HG_OVERLAYS: { key: OverlayKey; label: string }[] = [
  { key: "blocks", label: "Blocks (TX/NM grid)" },
  { key: "sections", label: "Sections (numbered, z≥11)" },
];

// numeric range sliders (min/max entry, seeded with the facet bounds)
// `sources` limits a row to one forecast source (default: both — Novi screen attributes).
const BOX_RANGE_HINT = "BOX bounds apply to covered PUDs only; a PUD without a BOX forecast stays in the screen, counted under its not-covered class.";
const RANGE_FIELDS: { col: string; label: string; money?: boolean; hint?: string; sources?: ForecastSource[] }[] = [
  { col: "rqs", label: "Rock-quality score" },
  { col: "spacing_s", label: "Spacing score" },
  { col: "deplet_s", label: "Depletion score" },
  { col: "complet_s", label: "Completion score" },
  { col: "npv25", label: "NPV @ 25% ($)", money: true, sources: ["novi"] },
  { col: "oil_eur", label: "Oil EUR (bbl)", sources: ["novi"] },
  { col: "box_oil_eur", label: "BOX oil EUR (bbl)", sources: ["box"], hint: BOX_RANGE_HINT },
  { col: "box_oil_eur_per_kft", label: "BOX oil EUR / 1,000 ft (bbl)", sources: ["box"], hint: BOX_RANGE_HINT },
  { col: "ll_ft", label: "Lateral length (ft)" },
  // offset-PDP support (curated.intel_pdp_support, sql/30) — verifiability screen
  { col: "pdp_count_3mi", label: "PDP offsets (3 mi)" },
  { col: "dist_nearest_ft", label: "Nearest PDP (ft)" },
  { col: "inflation_ratio", label: "EUR/ft vs offsets (×)" },
  // depth-plausibility screens (sql/30, 2026-09 WCB_2 deep-TVD audit). Any bound
  // also drops blank-valued sticks (no same-bench / no WCA PDP within 3 mi).
  { col: "tvd_excess_3mi_ft", label: "TVD vs deepest offset (ft)",
    hint: "Stick TVD minus the deepest same-bench producer within 3 mi. > 200 ft = deeper than anything developed locally (suspect Novi landing) — max 200 on by default; clearing it also readmits sticks with no in-bench PDP within 3 mi." },
  { col: "wca_delta_ft", label: "TVD below WCA PDP (ft)",
    hint: "Stick TVD minus the local WCA producer median (3 mi). Real WCB_2 lands 400–700 ft below WCA — set that band when screening WCB_2." },
];

const EMPTY_CATS: Record<CategoricalField, string[]> = {
  formation_blueox: [], operator: [], spacing_t: [], deplet_t: [], complet_t: [], rqt: [],
};

// Highgrade default screens TRUE drillable inventory: not-already-drilled (the
// reconciliation gate, server-side) AND not offset-depleted. Novi's deplet_t
// Tier-4 = drained rock (frac grows into the depleted offset; produces water) —
// technically drillable, worthless — so on Novi the depletion-tier filter defaults to
// Tier-1/2/3 (Tier-4 off). The user can click Tier-4 back in to see it.
// BOX (gate 8, Michael 2026-10-15): no depletion-tier default. A BOX workup already
// carries offset depletion through its named analogs, so Novi's Tier-4 cut would
// double-count it — and it removed 1,307 of the 1,907 covered PUDs.
const DEFAULT_CATS: Record<ForecastSource, Record<CategoricalField, string[]>> = {
  novi: { ...EMPTY_CATS, deplet_t: ["Tier-1", "Tier-2", "Tier-3"] },
  box: { ...EMPTY_CATS },
};
const DEPLET_HINT: Record<ForecastSource, string> = {
  novi: "Tier-4 (offset-depleted) off by default — drained rock; click to include.",
  box: "No default on BOX: all tiers, Tier-4 included (see the BOX note above). Click tiers to screen anyway.",
};

type RangeMap = Record<string, [number | null, number | null]>;

// Depth-anomaly default (2026-09 WCB_2 deep-TVD audit): sticks landed > 200 ft
// deeper than any same-bench producer within 3 mi are suspect Novi landings —
// visible on the map, excluded from the default screen. The <= 200 bound also
// drops NULL rows (no same-bench PDP within 3 mi / unscored bench) — those are
// unverifiable, the same class the pdp_count_3mi floor targets. Clear the range
// to screen the full set.
const DEFAULT_RANGES: RangeMap = { tvd_excess_3mi_ft: [null, 200] };

export function HighgradePanel() {
  const basin = useMapStore((s) => s.basin);
  const setBasin = useMapStore((s) => s.setBasin);
  const highgrade = useMapStore((s) => s.highgrade);
  const setHighgrade = useMapStore((s) => s.setHighgrade);
  const setHighgradeFilters = useMapStore((s) => s.setHighgradeFilters);
  const includeRealized = useMapStore((s) => s.hgIncludeRealized);
  const setIncludeRealized = useMapStore((s) => s.setHgIncludeRealized);
  const closeHgGunbarrel = useMapStore((s) => s.closeHgGunbarrel);
  const overlays = useMapStore((s) => s.overlays);
  const toggleOverlay = useMapStore((s) => s.toggleOverlay);
  const source = useMapStore((s) => s.hgSource);
  const setSource = useMapStore((s) => s.setHgSource);
  const econDeck = useMapStore((s) => s.hgEconDeck);
  const setEconDeck = useMapStore((s) => s.setHgEconDeck);
  const boxMeta = useMapStore((s) => s.boxMeta);
  const setBoxMeta = useMapStore((s) => s.setBoxMeta);

  const [facets, setFacets] = useState<HighgradeFacets | null>(null);
  const [cats, setCats] = useState<Record<CategoricalField, string[]>>({ ...EMPTY_CATS });
  const [ranges, setRanges] = useState<RangeMap>({ ...DEFAULT_RANGES });
  const [metric, setMetric] = useState<HighgradeMetric>("npv25");
  const [agg, setAgg] = useState<HighgradeAgg>("sum");
  const [opSearch, setOpSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form on basin change (filters are basin-specific). Not on the
  // realized toggle — those selections stay valid across the wider/narrower set.
  useEffect(() => {
    setCats({ ...DEFAULT_CATS[useMapStore.getState().hgSource] });
    setRanges({ ...DEFAULT_RANGES });
    setOpSearch("");
  }, [basin]);

  // (Re)load facets on basin / realized-toggle / source change so the filter bounds /
  // distinct values reflect exactly the PUD population being screened.
  useEffect(() => {
    let live = true;
    setFacets(null);
    fetchFacets(basin, includeRealized, source)
      .then((f) => { if (live) setFacets(f); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [basin, includeRealized, source]);

  // BOX record run + provenance + Steven's priced decks, once per basin.
  useEffect(() => {
    if (source !== "box" || boxMeta?.basin === basin) return;
    let live = true;
    fetchBoxMeta(basin)
      .then((m) => {
        if (!live) return;
        setBoxMeta(m);
        setEconDeck(m.decks.length ? { deck_id: m.decks[0].deck_id, assumption_set_id: m.decks[0].assumption_set_id } : null);
      })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [source, basin, boxMeta, setBoxMeta, setEconDeck]);

  // A metric the new source does not carry falls back to that source's default;
  // source-only range bounds are dropped so they never leak into the other source.
  const switchSource = (src: ForecastSource) => {
    if (src === source) return;
    setSource(src);
    // the depletion-tier default differs by source (see DEFAULT_CATS)
    setCats((c) => ({ ...c, deplet_t: [...DEFAULT_CATS[src].deplet_t] }));
    setMetric((m) => (METRICS.find((x) => x.value === m)?.sources.includes(src) ? m : DEFAULT_METRIC[src]));
    setRanges((r) => {
      const out = { ...r };
      RANGE_FIELDS.forEach((f) => { if (f.sources && !f.sources.includes(src)) delete out[f.col]; });
      return out;
    });
  };

  // per_acre is only offered for the $-metrics; drop it if the metric changes away.
  useEffect(() => {
    if (!isMoneyMetric(metric)) setAgg((a) => (a === "per_acre" ? "sum" : a));
  }, [metric]);

  const toggleCat = (field: CategoricalField, value: string) =>
    setCats((c) => {
      const has = c[field].includes(value);
      return { ...c, [field]: has ? c[field].filter((v) => v !== value) : [...c[field], value] };
    });

  const setRange = (col: string, idx: 0 | 1, raw: string) =>
    setRanges((r) => {
      const cur = r[col] ?? [null, null];
      const next: [number | null, number | null] = [...cur] as [number | null, number | null];
      next[idx] = raw === "" ? null : Number(raw);
      const cleared = next[0] == null && next[1] == null;
      const out = { ...r };
      if (cleared) delete out[col];
      else out[col] = next;
      return out;
    });

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const filters: HighgradeFilters = {};
      (Object.keys(cats) as CategoricalField[]).forEach((f) => {
        if (cats[f].length) filters[f] = cats[f];
      });
      const rangeEntries = Object.entries(ranges).filter(([, [lo, hi]]) => lo != null || hi != null);
      if (rangeEntries.length) filters.ranges = Object.fromEntries(rangeEntries);
      const res = await fetchHighgradePads({
        basin, filters, metric, agg, include_realized: includeRealized, source,
        econ: metric.startsWith("box_pv") ? econDeck : null,
      });
      setHighgrade(res);
      // Record the applied screen so a per-DSU gunbarrel can grey off-filter wells.
      setHighgradeFilters(filters);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setCats({ ...DEFAULT_CATS[source] });
    setRanges({ ...DEFAULT_RANGES });
    setHighgrade(null);
    setHighgradeFilters(null);
    closeHgGunbarrel();
  };

  const isWellCount = metric === "well_count";
  const money = isMoneyMetric(metric);
  const perKft = isPerKftMetric(metric);
  const noEcon = source === "box" && (boxMeta?.decks.length ?? 0) === 0;
  const metricOptions = METRICS.filter((m) => m.sources.includes(source) && !(noEcon && m.value.startsWith("box_pv")));
  const rangeFields = RANGE_FIELDS.filter((f) => !f.sources || f.sources.includes(source));

  return (
    <div className="panel highgrade">
      <div className="seg">
        <button className={basin === "delaware" ? "active" : ""} onClick={() => setBasin("delaware")}>Delaware</button>
        <button className={basin === "midland" ? "active" : ""} onClick={() => setBasin("midland")}>Midland</button>
      </div>
      <div className="count">Screen undeveloped (BASE_CASE) inventory → highlight target pads.</div>

      <h3>Forecast source</h3>
      <div className="seg sm">
        <button className={source === "novi" ? "active" : ""} onClick={() => switchSource("novi")}>Novi</button>
        <button className={source === "box" ? "active" : ""} onClick={() => switchSource("box")}>BOX</button>
      </div>
      {source === "novi" && (
        <div className="count" style={{ margin: "2px 0 10px" }}>
          Novi Intelligence forecasts; NPV/PV = Novi's pre-computed screen on one flat deck, not an authoritative value.
        </div>
      )}
      {source === "box" && <BoxRunNote meta={boxMeta} />}
      {source === "box" && (
        <div className="count" style={{ margin: "0 0 10px" }}>
          Depletion tier: no default on BOX — Tier-4 (offset-depleted) PUDs are included, because each BOX workup
          already reflects offset depletion through its analogs. Click tiers to screen anyway.
        </div>
      )}

      <h3>Inventory</h3>
      <div className="seg sm">
        <button className={!includeRealized ? "active" : ""} onClick={() => setIncludeRealized(false)}>Drillable only</button>
        <button className={includeRealized ? "active" : ""} onClick={() => setIncludeRealized(true)}>All Novi BASE_CASE</button>
      </div>
      <div className="count" style={{ margin: "2px 0 10px" }}>
        {includeRealized
          ? "Every Novi BASE_CASE location, including those §6 reconciliation flags as already drilled."
          : "Remaining + conflict only; excludes BASE_CASE locations reconciliation matched to existing production (realized / phantom)."}
      </div>

      <h3>Metric (per pad)</h3>
      <div className="row" style={{ marginBottom: 6 }}>
        <select value={metric} onChange={(e) => setMetric(e.target.value as HighgradeMetric)} style={{ flex: 1, fontSize: 12 }}>
          {metricOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      {source === "box" && boxMeta && boxMeta.decks.length > 0 && metric.startsWith("box_pv") && (
        <div className="row" style={{ marginBottom: 6 }}>
          <select
            value={econDeck ? `${econDeck.deck_id}${DECK_SEP}${econDeck.assumption_set_id}` : ""}
            onChange={(e) => {
              const [deck_id, assumption_set_id] = e.target.value.split(DECK_SEP);
              setEconDeck({ deck_id, assumption_set_id });
            }}
            style={{ flex: 1, fontSize: 12 }}>
            {boxMeta.decks.map((d) => (
              <option key={`${d.deck_id}${DECK_SEP}${d.assumption_set_id}`} value={`${d.deck_id}${DECK_SEP}${d.assumption_set_id}`}>
                {d.deck_id} · {d.assumption_set_id} · {d.n_priced.toLocaleString()} priced
              </option>
            ))}
          </select>
        </div>
      )}
      {source === "box" && <BoxEconNote meta={boxMeta} deck={econDeck} metric={metric} />}
      {perKft && (
        <div className="count" style={{ margin: "0 0 10px" }}>Pad value = lateral-weighted: Σ EUR ÷ Σ lateral (kft).</div>
      )}
      {!isWellCount && !perKft && (
        <div className="seg sm" style={{ marginBottom: 10 }}>
          <button className={agg === "sum" ? "active" : ""} onClick={() => setAgg("sum")}>Sum</button>
          <button className={agg === "avg" ? "active" : ""} onClick={() => setAgg("avg")}>Avg / well</button>
          {money && (
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
          {TIER_FIELDS.map(({ field, label, hint }) => (
            <ChipGroup
              key={field}
              label={label}
              hint={field === "deplet_t" ? DEPLET_HINT[source] : hint}
              options={facets.categorical[field]}
              selected={cats[field]}
              onToggle={(v) => toggleCat(field, v)}
            />
          ))}

          <ChipGroup
            label="Formation (Blue Ox)"
            options={facets.categorical.formation_blueox}
            selected={cats.formation_blueox}
            onToggle={(v) => toggleCat("formation_blueox", v)}
            swatch={(code) => colorForBlueox(basin, code)}
          />

          <h3>Operator {cats.operator.length > 0 && <span className="hg-n">({cats.operator.length})</span>}</h3>
          <input
            placeholder="Search operators…"
            value={opSearch}
            onChange={(e) => setOpSearch(e.target.value)}
            style={{ width: "100%", fontSize: 12, marginBottom: 4 }}
          />
          <div className="hg-oplist">
            {facets.categorical.operator
              .filter((o) => o.toLowerCase().includes(opSearch.toLowerCase()))
              .map((o) => (
                <label key={o} className="hg-oprow">
                  <input type="checkbox" checked={cats.operator.includes(o)} onChange={() => toggleCat("operator", o)} />
                  <span>{o}</span>
                </label>
              ))}
          </div>

          <h3 style={{ marginTop: 10 }}>Ranges</h3>
          {rangeFields.map(({ col, label, money: m, hint }) => (
            <RangeRow
              key={col}
              label={label}
              hint={hint}
              bounds={facets.numeric[col]}
              value={ranges[col] ?? [null, null]}
              money={m}
              onChange={(idx, raw) => setRange(col, idx, raw)}
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

      {highgrade && (
        <div className="hg-summary">
          <div><strong>{highgrade.pad_count.toLocaleString()}</strong> pads · <strong>{highgrade.well_count.toLocaleString()}</strong> wells</div>
          <div className="count" style={{ margin: "2px 0 0" }}>
            {highgrade.source === "box" ? "BOX " : ""}{METRICS.find((m) => m.value === highgrade.metric)?.label}
            {highgrade.metric === "well_count" ? ""
              : isPerKftMetric(highgrade.metric) ? " · lateral-weighted / pad"
              : ` · ${aggLabel(highgrade.agg)}`}: {fmt(highgrade.value_min, isMoneyMetric(highgrade.metric))} … {fmt(highgrade.value_max, isMoneyMetric(highgrade.metric))}
          </div>
          {highgrade.source === "box" && highgrade.coverage_counts && (
            <CoverageSummary counts={highgrade.coverage_counts} valued={highgrade.valued_count ?? 0}
              total={highgrade.well_count + highgrade.wells_without_pad} metric={highgrade.metric}
              padsUnvalued={highgrade.pads_unvalued ?? 0} />
          )}
          {highgrade.pads_missing_geom > 0 && (
            <div className="count" style={{ margin: "2px 0 0", color: "#92400e" }}>
              {highgrade.pads_missing_geom.toLocaleString()} matching pads have no polygon (not drawn)
            </div>
          )}
          {highgrade.wells_without_pad > 0 && (
            <div className="count" style={{ margin: "2px 0 0", color: "#92400e" }}>
              {highgrade.wells_without_pad.toLocaleString()} screened PUDs have no Novi pad assignment this
              vintage (not drawn){highgrade.pad_count === 0 ? " — Novi shipped no pads for this basin" : ""}
            </div>
          )}
          {highgrade.names_split > 0 && (
            <div className="count" style={{ margin: "2px 0 0", color: "#92400e" }}>
              {highgrade.names_split.toLocaleString()} Novi pad names span separate stick groups
              (&gt;1 mi apart) — split into separate pads labelled [k/n]
            </div>
          )}
          {highgrade.pad_count > 0 && (
            <div className="count" style={{ margin: "2px 0 0" }}>
              Pad outlines = member-stick hull + 330 ft (Novi ships no pad polygons); stacked-bench pads overlap.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RangeRow({
  label, hint, bounds, value, money, onChange,
}: {
  label: string;
  hint?: string;
  bounds: { min: number | null; max: number | null } | undefined;
  value: [number | null, number | null];
  money?: boolean;
  onChange: (idx: 0 | 1, raw: string) => void;
}) {
  const ph = (v: number | null) => (v == null ? "" : money ? Math.round(v).toString() : trim(v));
  return (
    <div className="hg-range">
      <div className="hg-range-label" title={hint}>{label}{hint ? " ⓘ" : ""}</div>
      <div className="hg-range-inputs">
        <input
          type="number" inputMode="decimal" placeholder={`min ${ph(bounds?.min ?? null)}`}
          value={value[0] ?? ""} onChange={(e) => onChange(0, e.target.value)}
        />
        <span>–</span>
        <input
          type="number" inputMode="decimal" placeholder={`max ${ph(bounds?.max ?? null)}`}
          value={value[1] ?? ""} onChange={(e) => onChange(1, e.target.value)}
        />
      </div>
    </div>
  );
}

function aggLabel(agg: string): string {
  return agg === "per_acre" ? "$/acre" : agg === "avg" ? "avg / well" : agg;
}

function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

// BOX provenance + the method statement every BOX number carries (D59 condition 3,
// D62/D63/D72). Sibling of the Novi caveat line.
function BoxRunNote({ meta }: { meta: BoxMeta | null }) {
  if (!meta) return <div className="count">Loading BOX record run…</div>;
  const r = meta.run;
  const oil = meta.disclosure.filter((d) => d.stream === "oil");
  const d92 = meta.haircut_method.method != null;
  const tail = meta.haircut_method.tail?.oil;
  const others = (meta.groups ?? []).filter((g) => g.group !== "WCA");
  return (
    <div className="caveat" style={{ margin: "4px 0 10px" }}>
      <div>
        <strong>BOX run {r.run_id}</strong> (record) · Novi {r.report_version} sticks · production through {r.data_through} ·
        code {r.code_sha.slice(0, 7)}
      </div>
      <div style={{ marginTop: 4 }}>
        Analog-workup forecasts (D57): deal-intake analog cohort <strong>P50</strong> per 1,000 ft × lateral, then a
        stated walk-forward haircut. Uptime-free (apply F(k) or a downtime factor, never both); oil + gas only, no
        water (D72); EUR = raw 50-yr technical integral. Covers Delaware {(meta.groups ?? []).map((g) => g.formations.join(" / ")).join(", ") || "WCA_1 / WCA_2"}{" "}
        inside their extents; every other PUD is shown as not covered, never zero. The table is WCA's; each pad workup
        shows its own group's.
      </div>
      <table className="hg-box-tbl">
        <thead><tr><th>oil</th><th>measured bias</th><th>{d92 ? "D62 target" : "haircut"}</th>{d92 && <th>realised (D92)</th>}<th>held-out after</th></tr></thead>
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
          : "The cum-48 factor holds for the 50-yr EUR (D62)."}
      </div>
      {others.length > 0 && (
        <table className="hg-box-tbl">
          <thead><tr><th>oil, other groups</th>{oil.map((d) => <th key={d.horizon}>{d.horizon}</th>)}</tr></thead>
          <tbody>
            {others.map((g) => (
              <tr key={g.group}>
                <td>{g.group === "WCXY_WCA1" ? "WCXY" : g.group} ({g.spec}): haircut · disclosed bias</td>
                {g.disclosure.filter((d) => d.stream === "oil").map((d) => (
                  <td key={d.horizon}>×{d.haircut.toFixed(3)} · {pct(d.disclosed_bias ?? null)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {meta.stale && (
        <div style={{ color: "#991b1b", marginTop: 4 }}>
          The warehouse holds Novi {meta.intel_report_versions.join(", ")}; this run keys on {r.report_version} sticks —
          BOX coverage reads as "no BOX row" until the quarterly BOX refresh.
        </div>
      )}
    </div>
  );
}

// BOX econ sibling of the Novi NPV caveat: Steven's box_econ screen with provenance.
function BoxEconNote({ meta, deck, metric }: { meta: BoxMeta | null; deck: EconDeck | null; metric: string }) {
  if (!meta) return null;
  if (meta.decks.length === 0) {
    return (
      <div className="count" style={{ margin: "0 0 8px" }}>
        BOX econ: none yet — Steven has not priced run {meta.run.run_id} (box_econ.box_pud_econ is empty for it).
        $ metrics appear here once he loads a deck.
      </div>
    );
  }
  if (!metric.startsWith("box_pv") || !deck) return null;
  const d = meta.decks.find((x) => x.deck_id === deck.deck_id && x.assumption_set_id === deck.assumption_set_id);
  return (
    <div className="count" style={{ margin: "0 0 8px" }}>
      Steven's economics on BOX run {meta.run.run_id} volumes — a display-only screen, not computed here (D13).
      Deck {deck.deck_id} / {deck.assumption_set_id}
      {d ? ` · WTI ${d.wti ?? "—"} · HH ${d.hh ?? "—"} · downtime: ${d.downtime_basis} · built ${d.built_at?.slice(0, 10) ?? "—"}` : ""}.
      Unpriced covered PUDs are counted, not zeroed.
    </div>
  );
}

function CoverageSummary({ counts, valued, total, metric, padsUnvalued }: {
  counts: Record<string, number>; valued: number; total: number; metric: string; padsUnvalued: number;
}) {
  const rows = Object.entries(COVERAGE_LABELS).filter(([k]) => (counts[k] ?? 0) > 0);
  const valueNote =
    metric === "well_count" ? "Well count includes every screened PUD."
    : metric.startsWith("box_pv") ? `${valued.toLocaleString()} priced PUDs carry the value; the rest are excluded, not zeroed.`
    : `${valued.toLocaleString()} covered PUDs carry the value; the rest are excluded, not zeroed.`;
  return (
    <div style={{ margin: "6px 0 0" }}>
      <div className="count" style={{ margin: 0 }}>BOX coverage of the {total.toLocaleString()} screened PUDs:</div>
      <table className="hg-box-tbl">
        <tbody>
          {rows.map(([k, label]) => (
            <tr key={k} className={k === "covered" ? "" : "nc"}>
              <td>{label}</td><td style={{ textAlign: "right" }}>{(counts[k] ?? 0).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="count" style={{ margin: "2px 0 0" }}>{valueNote}</div>
      {padsUnvalued > 0 && (
        <div className="count" style={{ margin: "2px 0 0" }}>
          {padsUnvalued.toLocaleString()} pads have no {metric.startsWith("box_pv") ? "priced" : "covered"} PUD — drawn grey.
        </div>
      )}
    </div>
  );
}
function fmt(v: number | null, money: boolean): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (money) return `$${Math.round(v).toLocaleString()}`;
  return Math.round(v).toLocaleString();
}
function trim(v: number): string {
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toPrecision(3);
}
