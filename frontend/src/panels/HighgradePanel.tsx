import { useEffect, useState } from "react";

import {
  fetchFacets,
  fetchHighgradePads,
  type CategoricalField,
  type HighgradeAgg,
  type HighgradeFacets,
  type HighgradeFilters,
  type HighgradeMetric,
} from "../api/highgrade";
import { colorForBlueox } from "../map/formations";
import { useMapStore, type OverlayKey } from "../store";

const METRICS: { value: HighgradeMetric; label: string }[] = [
  { value: "npv5", label: "NPV @ 5%" },
  { value: "npv10", label: "NPV @ 10%" },
  { value: "npv15", label: "NPV @ 15%" },
  { value: "npv20", label: "NPV @ 20%" },
  { value: "npv25", label: "NPV @ 25%" },
  { value: "pv5", label: "PV @ 5%" },
  { value: "pv10", label: "PV @ 10%" },
  { value: "pv15", label: "PV @ 15%" },
  { value: "pv20", label: "PV @ 20%" },
  { value: "pv25", label: "PV @ 25%" },
  { value: "oil_eur", label: "Oil EUR" },
  { value: "gas_eur", label: "Gas EUR" },
  { value: "well_count", label: "Well count" },
];

// tier multi-selects (4 chips each, Tier-1..4)
const TIER_FIELDS: { field: CategoricalField; label: string; hint?: string }[] = [
  { field: "rqt", label: "Rock quality tier" },
  { field: "spacing_t", label: "Spacing tier" },
  { field: "deplet_t", label: "Depletion tier",
    hint: "Tier-4 (offset-depleted) off by default — drained rock; click to include." },
  { field: "complet_t", label: "Completion tier" },
];

// map overlays surfaced on the Highgrade tab (same toggle mechanism as the Map tab's
// Controls panel; the layers are mode-agnostic so they render in Highgrade mode too).
const HG_OVERLAYS: { key: OverlayKey; label: string }[] = [
  { key: "blocks", label: "Blocks (TX/NM grid)" },
  { key: "sections", label: "Sections (numbered, z≥11)" },
];

// numeric range sliders (min/max entry, seeded with the facet bounds)
const RANGE_FIELDS: { col: string; label: string; money?: boolean }[] = [
  { col: "rqs", label: "Rock-quality score" },
  { col: "spacing_s", label: "Spacing score" },
  { col: "deplet_s", label: "Depletion score" },
  { col: "complet_s", label: "Completion score" },
  { col: "npv25", label: "NPV @ 25% ($)", money: true },
  { col: "oil_eur", label: "Oil EUR (bbl)" },
  { col: "ll_ft", label: "Lateral length (ft)" },
  // offset-PDP support (curated.intel_pdp_support, sql/30) — verifiability screen
  { col: "pdp_count_3mi", label: "PDP offsets (3 mi)" },
  { col: "dist_nearest_ft", label: "Nearest PDP (ft)" },
  { col: "inflation_ratio", label: "EUR/ft vs offsets (×)" },
];

const EMPTY_CATS: Record<CategoricalField, string[]> = {
  formation_blueox: [], operator: [], spacing_t: [], deplet_t: [], complet_t: [], rqt: [],
};

// Highgrade default screens TRUE drillable inventory: not-already-drilled (the
// reconciliation gate, server-side) AND not offset-depleted. Novi's deplet_t
// Tier-4 = drained rock (frac grows into the depleted offset; produces water) —
// technically drillable, worthless — so the depletion-tier filter defaults to
// Tier-1/2/3 (Tier-4 off). The user can click Tier-4 back in to see it.
const DEFAULT_CATS: Record<CategoricalField, string[]> = {
  ...EMPTY_CATS, deplet_t: ["Tier-1", "Tier-2", "Tier-3"],
};

type RangeMap = Record<string, [number | null, number | null]>;

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

  const [facets, setFacets] = useState<HighgradeFacets | null>(null);
  const [cats, setCats] = useState<Record<CategoricalField, string[]>>({ ...EMPTY_CATS });
  const [ranges, setRanges] = useState<RangeMap>({});
  const [metric, setMetric] = useState<HighgradeMetric>("npv25");
  const [agg, setAgg] = useState<HighgradeAgg>("sum");
  const [opSearch, setOpSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form on basin change (filters are basin-specific). Not on the
  // realized toggle — those selections stay valid across the wider/narrower set.
  useEffect(() => {
    setCats({ ...DEFAULT_CATS });
    setRanges({});
    setOpSearch("");
  }, [basin]);

  // (Re)load facets on basin or realized-toggle change so the filter bounds /
  // distinct values reflect exactly the PUD population being screened.
  useEffect(() => {
    let live = true;
    setFacets(null);
    fetchFacets(basin, includeRealized)
      .then((f) => { if (live) setFacets(f); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [basin, includeRealized]);

  // per_acre is only offered for the $-metrics; drop it if the metric changes away.
  useEffect(() => {
    const isMoney = metric.startsWith("npv") || metric.startsWith("pv");
    if (!isMoney) setAgg((a) => (a === "per_acre" ? "sum" : a));
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
      const res = await fetchHighgradePads({ basin, filters, metric, agg, include_realized: includeRealized });
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
    setCats({ ...DEFAULT_CATS });
    setRanges({});
    setHighgrade(null);
    setHighgradeFilters(null);
    closeHgGunbarrel();
  };

  const isWellCount = metric === "well_count";
  const money = metric.startsWith("npv") || metric.startsWith("pv");

  return (
    <div className="panel highgrade">
      <div className="seg">
        <button className={basin === "delaware" ? "active" : ""} onClick={() => setBasin("delaware")}>Delaware</button>
        <button className={basin === "midland" ? "active" : ""} onClick={() => setBasin("midland")}>Midland</button>
      </div>
      <div className="count">Screen undeveloped (BASE_CASE) inventory → highlight target pads.</div>

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
          {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      {!isWellCount && (
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
              hint={hint}
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
          {RANGE_FIELDS.map(({ col, label, money: m }) => (
            <RangeRow
              key={col}
              label={label}
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
            {METRICS.find((m) => m.value === highgrade.metric)?.label}
            {highgrade.metric !== "well_count" ? ` · ${aggLabel(highgrade.agg)}` : ""}: {fmt(highgrade.value_min, money)} … {fmt(highgrade.value_max, money)}
          </div>
          {highgrade.pads_missing_geom > 0 && (
            <div className="count" style={{ margin: "2px 0 0", color: "#92400e" }}>
              {highgrade.pads_missing_geom.toLocaleString()} matching pads have no polygon (not drawn)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChipGroup({
  label, options, selected, onToggle, swatch, hint,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  swatch?: (name: string) => string;
  hint?: string;
}) {
  if (!options || options.length === 0) return null;
  return (
    <div className="hg-chipgroup">
      <h3>{label} {selected.length === 0 ? <span className="hg-n">(all)</span> : <span className="hg-n">({selected.length})</span>}</h3>
      {hint && <div className="count" style={{ margin: "0 0 4px" }}>{hint}</div>}
      <div className="hg-chips">
        {options.map((o) => (
          <button
            key={o}
            className={`hg-chip${selected.includes(o) ? " on" : ""}`}
            onClick={() => onToggle(o)}
          >
            {swatch && <span className="swatch" style={{ background: swatch(o), width: 9, height: 9, marginRight: 4 }} />}
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function RangeRow({
  label, bounds, value, money, onChange,
}: {
  label: string;
  bounds: { min: number | null; max: number | null } | undefined;
  value: [number | null, number | null];
  money?: boolean;
  onChange: (idx: 0 | 1, raw: string) => void;
}) {
  const ph = (v: number | null) => (v == null ? "" : money ? Math.round(v).toString() : trim(v));
  return (
    <div className="hg-range">
      <div className="hg-range-label">{label}</div>
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
  return agg === "per_acre" ? "$/acre" : agg;
}
function fmt(v: number | null, money: boolean): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (money) return `$${Math.round(v).toLocaleString()}`;
  return Math.round(v).toLocaleString();
}
function trim(v: number): string {
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toPrecision(3);
}
