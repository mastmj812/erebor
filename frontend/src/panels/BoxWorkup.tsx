import { useEffect, useState } from "react";

import {
  COVERAGE_LABELS, PROX_OUTCOME_GROUP, fetchBoxPad, isForecastClass, type BoxChart, type BoxGroup, type BoxPad,
  type BoxPadLocation, type BoxPadParent, type BoxProximity, type BoxTierLine,
} from "../api/highgrade";

// BOX workup for one Highgrade pad, rendered on demand from box.* (D80: the database
// is the record, pages are renders). Same content as engineering_db's committed pad
// pages (box/production_pages.py): method statement + measured bias / haircut (D59
// condition 3), radius-class range (D69), locations, forecast vs analog actuals, the
// named analogs. Plus the Novi number next to each BOX one (the toggle's comparison), and the
// PDP-proximity layer (record run 14, D112–D116): each PUD's parent configuration, its oil factor or
// no-precedent outcome, the precedent counts and the named parents.

const n0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString());
const pct = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

export function BoxWorkup({ basin, padKey }: { basin: string; padKey: string }) {
  const [data, setData] = useState<BoxPad | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    fetchBoxPad(basin, padKey)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [basin, padKey]);

  if (error) return <div className="caveat">{error}</div>;
  if (!data) return <div className="count">Loading BOX workup…</div>;

  const r = data.run;
  const d92 = data.haircut_method.method != null;
  // one disclosure block per coverage group on the pad (D103); a pre-9c backend sends none -> the WCA top level
  const groups: BoxGroup[] = data.groups ?? [{
    group: "WCA", label: "WCA_1 / WCA_2", formations: ["WCA_1", "WCA_2"], spec: "box_v2_wf",
    radius_basis: "held-out packages (D69)", disclosure: data.disclosure, haircut_method: data.haircut_method,
    radius_ranges: data.radius_ranges, calendar_factor: data.calendar_factor,
  }];
  // both tiers carry a forecast (D105); their counts stay apart
  const covered = data.locations.filter((l) => isForecastClass(l.coverage));
  const others = data.locations.filter((l) => !isForecastClass(l.coverage));
  const nVal = covered.filter((l) => l.coverage === "covered").length;
  const nProv = covered.length - nVal;
  const anyProv = groups.some((g) => g.tier === "provisional");
  const hasWater = covered.some((l) => l.water_eur != null);
  const byClass = others.reduce<Record<string, number>>((a, l) => ({ ...a, [l.coverage]: (a[l.coverage] ?? 0) + 1 }), {});
  const measured = data.locations.filter((l) => l.prox_outcome != null);
  const nHaircut = measured.filter((l) => l.prox_outcome === "haircut").length;

  return (
    <div className="box-wu">
      <div className="count" style={{ margin: 0 }}>
        BOX run {r.run_id} · spec {groups.map((g) => g.spec).filter((v, i, a) => a.indexOf(v) === i).join(" + ")} · code {r.code_sha.slice(0, 7)} · boxfit {r.engine_sha?.slice(0, 7)} ·
        deal-intake config v{r.dealintake_config} · Novi {r.report_version} · production through {r.data_through} ·
        {" "}{nVal} covered (validated){nProv > 0 ? ` · ${nProv} covered PROVISIONAL (D105)` : ""} of {data.locations.length} PUDs ·
        {" "}{data.analogs.length} named analogs
      </div>

      {others.length > 0 && (
        <div className="count" style={{ margin: "4px 0 0" }}>
          Not covered: {Object.entries(byClass).map(([k, n]) => `${n} ${COVERAGE_LABELS[k] ?? k}`).join(" · ")} — shown, never zeroed.
        </div>
      )}

      {covered.length > 0 && (
        <>
          <div className="caveat">
            <strong>How to read this workup.</strong> Forecast = the analog cohort's <strong>P50</strong> per 1,000 ft
            (deal-intake selection: same bench, nearest-first, lateral band, representative spacing; D57), scaled to the
            location's lateral (Cui &amp; Cross below 7,500 ft, D50), then the stated walk-forward haircut (D62 factors
            {d92 ? ", applied to the rate as a smooth curve fitted to them per location — D92" : ""}; BS2_S its own, D94 / D102;
            WCXY none, D97{anyProv ? "; provisional benches none, D105" : ""}){data.proximity
              ? <>, then for a PUD with 2+ depleted parents the PDP-proximity <strong>oil</strong> factor of its configuration
                (D113; gas and water untouched; a configuration without drilled precedent gets no forecast, D114)</>
              : null}. Volumes
            are <strong>uptime-free</strong> (D63); EUR = raw 50-yr technical integral, no economic limit.
            {hasWater
              ? <> <strong>Water</strong> = WOR vs cumulative oil fitted on nearby same-bench wells with MEASURED water
                  (reaching up to 50 mi; a calculated-water fallback is flagged), applied to the raw box_v2 oil before any
                  haircut; it carries its own tier — validated on WCA / BS2_S, provisional elsewhere (D107–D110).</>
              : " Oil + gas only on this run."}
            {" "}Error = actual ÷ forecast − 1 (negative = the method forecast HIGH).
            {anyProv && (
              <>
                {" "}<span className="box-prov-badge">PROVISIONAL</span> benches (D105) carry a forecast exactly like a
                validated one but were never out-of-time validated, or failed their one-time holdout: read each one with its
                own disclosure below.
              </>
            )}
          </div>
          {groups.map((g) => <GroupDisclosure key={g.group} g={g} multi={groups.length > 1 || g.group !== "WCA"} />)}
          {hasWater && <WaterDisclosure groups={groups} />}
        </>
      )}

      <h4>Locations — BOX vs Novi</h4>
      <LocationsTable rows={[...covered, ...others]} />

      {measured.length > 0 && (
        <>
          <h4>PDP proximity (D112–D116){nHaircut > 0 ? ` — ${nHaircut} oil haircut` : ""}</h4>
          {data.proximity && <BoxProximityNote p={data.proximity} compact />}
          <ProximityTable rows={measured} />
          {(data.parents ?? []).length > 0 && (
            <>
              <h5 style={{ margin: "6px 0 2px" }}>Named parents ({(data.parents ?? []).length})</h5>
              <ParentsTable parents={data.parents ?? []} locations={measured} />
            </>
          )}
        </>
      )}

      {data.chart && (
        <>
          <h4>Forecast vs analog actuals (oil, cumulative per 1,000 ft)</h4>
          <Chart chart={data.chart} />
          <div className="count" style={{ margin: "2px 0 0" }}>
            Blue = each validated location's forecast (P50 × haircut, uptime-free){nProv > 0 ? "; amber dashed = each PROVISIONAL location's (raw P50, no haircut, D105)" : ""}{nHaircut > 0
              ? "; either × its PDP-proximity oil factor where multi-parent (D113)" : ""}. Grey = the named analogs' ACTUAL calendar
            cumulative per 1,000 ft: P10 (high) – P90 (low) band and P50, months with ≥ 3 analogs reporting
            ({data.chart.n_analog_curves} analogs). Calendar actuals carry downtime; the forecast does not (D63).
          </div>
        </>
      )}

      {data.water_chart && (
        <>
          <h4>Water forecast vs measured-water analog actuals (cumulative per 1,000 ft)</h4>
          <Chart chart={data.water_chart} label="BOX water forecast vs measured-water analog actuals" />
          <div className="count" style={{ margin: "2px 0 0" }}>
            Blue = each location's water with VALIDATED tier; amber dashed = PROVISIONAL water. Grey = the named
            measured-water analogs' ACTUAL calendar water per 1,000 ft (P10 high – P90 low, P50; {data.water_chart.n_analog_curves} analogs).
          </div>
        </>
      )}

      {data.analogs.length > 0 && (
        <>
          <h4>Named analogs</h4>
          <table className="box-tbl">
            <thead><tr><th>api10</th><th>well</th><th>operator</th><th>first prod</th><th>lateral ft</th><th>nearest ft</th><th>used by</th></tr></thead>
            <tbody>
              {data.analogs.map((a) => (
                <tr key={a.api10}>
                  <td>{a.api10}</td><td>{a.well_name ?? "—"}{a.transfer ? " (transfer)" : ""}</td><td>{a.operator ?? "—"}</td>
                  <td>{a.first_production ?? "—"}</td><td>{n0(a.lateral_ft)}</td><td>{n0(a.nearest_ft)}</td><td>{a.used_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {(data.water_analogs?.length ?? 0) > 0 && (
        <>
          <h4>Named water analogs (measured water; a different, wider set than the oil / gas cohort)</h4>
          <table className="box-tbl">
            <thead><tr><th>api10</th><th>well</th><th>operator</th><th>state</th><th>water label</th><th>first prod</th><th>lateral ft</th><th>nearest ft</th><th>used by</th></tr></thead>
            <tbody>
              {data.water_analogs!.map((a) => (
                <tr key={a.api10}>
                  <td>{a.api10}</td><td>{a.well_name ?? "—"}</td><td>{a.operator ?? "—"}</td>
                  <td>{a.state_code === "30" ? "NM" : a.state_code === "42" ? "TX" : "—"}</td>
                  <td>{a.water_label}</td><td>{a.first_production ?? "—"}</td><td>{n0(a.lateral_ft)}</td><td>{n0(a.nearest_ft)}</td><td>{a.used_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// Water disclosure (D110) for the pad's groups: tier, tuning / holdout / pooled bias side by side (never the
// pooled figure alone), and each group's caveat (WCA-TX holdout over-forecast; tuning-only for AVA / BS2_C).
function WaterDisclosure({ groups }: { groups: BoxGroup[] }) {
  const ws = groups.filter((g) => g.water);
  if (!ws.length) return null;
  return (
    <>
      <h4>Water: measured bias by group (D110)</h4>
      <table className="box-tbl">
        <thead>
          <tr><th>group</th><th>water tier</th><th>horizon</th><th>tuning bias · packages</th><th>holdout bias · packages</th><th>pooled bias · packages</th></tr>
        </thead>
        <tbody>
          {ws.flatMap((g) => g.water!.lines.map((l, i) => (
            <tr key={`${g.group}${l.horizon}`}>
              <td>{i === 0 ? g.group : ""}</td>
              <td>{i === 0 ? (g.water!.tier === "provisional" ? <span className="box-prov-badge">PROVISIONAL</span> : "validated") : ""}</td>
              <td>{l.horizon}</td>
              <td>{pct(l.tuning_bias)} · {n0(l.tuning_packages)}</td>
              <td className="box-hold">{l.holdout_bias == null ? "no holdout" : `${pct(l.holdout_bias)} · ${n0(l.holdout_packages)}`}</td>
              <td>{pct(l.pooled_bias)} · {n0(l.pooled_packages)}</td>
            </tr>
          )))}
        </tbody>
      </table>
      {ws.filter((g) => g.water!.caveat).map((g) => (
        <div key={g.group} className="count" style={{ margin: "2px 0 0" }}><strong>{g.group}:</strong> {g.water!.caveat}</div>
      ))}
    </>
  );
}

function LocationsTable({ rows }: { rows: BoxPadLocation[] }) {
  return (
    <table className="box-tbl">
      <thead>
        <tr>
          <th>stick</th><th>bench</th><th>BOX coverage</th><th>lateral ft</th><th>spacing ft</th><th>analogs · radius</th>
          <th>BOX oil EUR bbl</th><th>EUR haircut</th><th>PDP prox ×</th><th>BOX oil /kft</th><th>Novi oil /kft</th><th>BOX ÷ Novi</th><th>oil cum-12</th>
          <th>oil Di nom (1-yr eff) · b</th><th>BOX gas EUR mcf</th>
          <th>BOX water EUR bbl</th><th>water /kft</th><th>WOR cum-12</th><th>water tier · analogs · reach</th><th>flags</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => {
          const cov = isForecastClass(l.coverage);
          const ratio = cov && l.oil_eur_per_kft && l.novi_oil_eur_per_kft ? l.oil_eur_per_kft / l.novi_oil_eur_per_kft : null;
          return (
            <tr key={l.stick_id} className={cov ? "" : "nc"}>
              <td title={l.unique_id}>{l.stick_id}</td>
              <td>{l.formation_blueox}</td>
              <td>{l.coverage === "covered" ? "covered"
                : l.coverage === "covered_provisional" ? <span className="box-prov-badge">PROVISIONAL</span>
                : COVERAGE_LABELS[l.coverage] ?? l.coverage}</td>
              <td>{n0(cov ? l.lateral_ft : l.ll_ft)}</td>
              <td>{cov ? `${n0(l.planned_spacing_ft)}${l.spacing_source === "default_880" ? " (default)" : ""}` : ""}</td>
              <td>{cov || l.n_analogs != null ? `${l.n_analogs ?? "—"} · ${l.radius_mi?.toFixed(1) ?? "—"} mi${l.search_mode === "strike" ? " strike" : ""}` : ""}</td>
              <td>{cov ? n0(l.oil_eur) : "not covered"}</td>
              <td>{cov && l.oil_haircut != null ? `×${l.oil_haircut.toFixed(3)}` : ""}</td>
              <td title={l.prox_outcome_text ?? undefined}>{proxCell(l)}</td>
              <td>{cov ? n0(l.oil_eur_per_kft) : ""}</td>
              <td>{n0(l.novi_oil_eur_per_kft)}</td>
              <td>{ratio == null ? "" : `${ratio.toFixed(2)}×`}</td>
              <td>{cov ? n0(l.oil_cum12) : ""}</td>
              <td>{cov && l.oil_di_nominal != null
                ? `${l.oil_di_nominal.toFixed(2)}/yr (${((l.oil_di_eff_1yr ?? 0) * 100).toFixed(0)}%) · ${l.oil_b?.toFixed(2) ?? "—"}`
                : ""}</td>
              <td>{cov ? n0(l.gas_eur) : ""}</td>
              <td>{cov ? n0(l.water_eur) : ""}</td>
              <td>{cov ? n0(l.water_eur_per_kft) : ""}</td>
              <td>{cov && l.water_wor_cum12 != null ? l.water_wor_cum12.toFixed(2) : ""}</td>
              <td>{cov && l.water_eur != null ? <>
                {l.water_tier === "provisional" ? <span className="box-prov-badge">PROV</span> : "validated"}
                {` · ${l.water_n_analogs ?? "—"} · ${l.water_radius_mi?.toFixed(1) ?? "—"} mi`}
                {l.water_source === "calculated_fallback" ? " · CALCULATED fallback" : l.water_thin ? " · thin" : ""}
              </> : ""}</td>
              <td className="box-flags">{(l.flags ?? []).join("; ")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// The location table's PDP-proximity cell: the oil factor the stored EUR carries, or why there is none.
function proxCell(l: BoxPadLocation): string {
  const g = l.prox_outcome ? PROX_OUTCOME_GROUP[l.prox_outcome] : undefined;
  if (g === "haircut") return `×${(l.oil_prox_factor ?? l.prox_factor ?? 1).toFixed(3)}`;
  if (g === "as_is") return "×1 (as-is)";
  if (g === "no_precedent") return "no precedent";
  return "";
}

const n0f = (v: number) => Math.round(v).toLocaleString();

// One row per measured PUD: configuration in words, outcome, factor + label, precedent counts, flags.
function ProximityTable({ rows }: { rows: BoxPadLocation[] }) {
  return (
    <table className="box-tbl">
      <thead>
        <tr>
          <th>stick</th><th>bench</th><th>configuration (parents ≥ 12 mo, ≥ 30 % alongside)</th><th>outcome</th>
          <th>oil factor</th><th>basis</th><th>precedent (bench pair: drilled multi-parent wells · packages)</th><th>flags</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => {
          const g = l.prox_outcome ? PROX_OUTCOME_GROUP[l.prox_outcome] : undefined;
          const flags = [
            l.prox_n_permit_parents ? `${l.prox_n_permit_parents} parent${l.prox_n_permit_parents === 1 ? "" : "s"} on a permit-round TVD` : "",
            l.prox_n_recent_producers ? `${l.prox_n_recent_producers} producer${l.prox_n_recent_producers === 1 ? "" : "s"} < 12 mo in the envelope (a parent within the year; not counted)` : "",
          ].filter(Boolean);
          return (
            <tr key={l.stick_id} className={g === "no_precedent" ? "nc" : ""}>
              <td title={l.unique_id}>{l.stick_id}</td>
              <td>{l.formation_blueox}</td>
              <td>{l.prox_config_line ?? "—"}</td>
              <td className={g === "no_precedent" ? "box-hold" : undefined}>{l.prox_outcome_text ?? l.prox_outcome}</td>
              <td>{g === "haircut" ? <strong>×{(l.oil_prox_factor ?? l.prox_factor ?? 1).toFixed(3)}</strong>
                : g === "no_precedent" ? `(table ×${l.prox_factor?.toFixed(3) ?? "—"}, not applied)` : "×1"}</td>
              <td>{[l.prox_label === "validated_with_exception" ? "validated with exception" : "", l.prox_haircut_key ?? ""]
                .filter(Boolean).join(" · ")}</td>
              <td>{l.prox_pair_key ? `${l.prox_pair_key}: ${l.prox_prec_multi ?? "—"} wells · ${l.prox_prec_package ?? "—"} packages` : ""}</td>
              <td className="box-flags">{flags.join("; ")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// The named parents behind each configuration (box.pud_proximity_parent), nearest first per PUD.
function ParentsTable({ parents, locations }: { parents: BoxPadParent[]; locations: BoxPadLocation[] }) {
  const bench = Object.fromEntries(locations.map((l) => [l.stick_id, l.formation_blueox]));
  return (
    <table className="box-tbl">
      <thead>
        <tr>
          <th>PUD stick</th><th>PUD bench</th><th>parent api10</th><th>well</th><th>operator</th><th>class</th><th>parent bench</th>
          <th>vt ft</th><th>hz ft</th><th>offset ft (+ = left of heading)</th><th>alongside</th><th>age at data date</th><th>permit TVD</th>
        </tr>
      </thead>
      <tbody>
        {parents.map((p) => (
          <tr key={`${p.location_id}-${p.api10}`}>
            <td>{p.stick_id}</td><td>{bench[p.stick_id] ?? "—"}</td><td>{p.api10}</td><td>{p.well_name ?? "—"}</td><td>{p.operator ?? "—"}</td>
            <td>{p.cls}</td><td>{p.parent_bench}</td><td>{n0f(p.dv_ft)}</td><td>{n0f(p.dh_ft)}</td>
            <td>{`${p.dxy_ft >= 0 ? "+" : "−"}${n0f(Math.abs(p.dxy_ft))}`}</td>
            <td>{(p.overlap * 100).toFixed(0)}%</td><td>{(p.age_days / 365.25).toFixed(1)} yr</td><td>{p.permit ? "yes" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// The run-level PDP-proximity disclosure (forecast_run.disclosure.proximity): method, the "validated with
// exception" basis (the pre-registered verdict as written beside what it was accepted as), the survivorship
// caveat, the prospective confirmation, the outcome counts and the oil EUR effect. Shared with the Highgrade note.
export function BoxProximityNote({ p, compact = false }: { p: BoxProximity; compact?: boolean }) {
  const c = p.counts;
  const nNoPrec = (c.no_forecast_precedent ?? 0) + (c.no_forecast_package ?? 0);
  const eurPct = p.oil_eur_change == null ? null : `${p.oil_eur_change >= 0 ? "+" : ""}${(p.oil_eur_change * 100).toFixed(1)}%`;
  return (
    <div className="box-prov" style={{ marginTop: 6 }}>
      <div className="count" style={{ margin: 0 }}>
        <strong>PDP proximity (D112–D116)</strong> · <span className="box-prov-badge">VALIDATED WITH EXCEPTION</span>
        {" "}{p.table_ref ? `· ${p.table_ref}` : ""}
      </div>
      {!compact && <div className="count" style={{ margin: "2px 0 0" }}>{p.method}</div>}
      <div className="count" style={{ margin: "2px 0 0" }}>
        <strong>Basis:</strong> pre-registered walk-forward (prereg {p.prereg_commit ?? "—"}) as written: {p.verdict_as_written ?? "—"}.
        Accepted as {p.accepted_as ?? "—"}. Confirmation: {p.confirmation ?? "—"}.
      </div>
      <div className="count" style={{ margin: "2px 0 0", color: "#92400e" }}>
        <strong>Survivorship:</strong> {p.survivorship ?? "—"}.
      </div>
      {!compact && (
        <div className="count" style={{ margin: "2px 0 0" }}>
          Run-wide: {(c.haircut ?? 0).toLocaleString()} haircut · {nNoPrec.toLocaleString()} no precedent, no forecast
          ({(c.no_forecast_precedent ?? 0).toLocaleString()} bench pair &lt; 30 multi-parent wells · {(c.no_forecast_package ?? 0).toLocaleString()} factor ≤ 0.80 with &lt; 30 packages)
          · {(c.as_is_single_parent ?? 0).toLocaleString()} single parent · {(c.as_is_unexposed ?? 0).toLocaleString()} unexposed.
          {p.oil_eur_mmbbl_before != null && p.oil_eur_mmbbl_after != null && (
            <> Oil EUR {Math.round(p.oil_eur_mmbbl_before).toLocaleString()} → {Math.round(p.oil_eur_mmbbl_after).toLocaleString()} MMbbl
              ({eurPct}) vs run {p.source_run ?? "—"}.</>
          )}{" "}Gas and water untouched.
        </div>
      )}
    </div>
  );
}

function Chart({ chart, label = "BOX forecast vs analog actuals" }: { chart: BoxChart; label?: string }) {
  const W = 640, H = 240, L = 56, R = 10, T = 8, B = 28;
  const K = chart.months;
  const band = chart.analog_band;
  const vals: number[] = [];
  chart.forecast.forEach((f) => vals.push(...f.cum_per_kft));
  band?.p10.forEach((v) => { if (v != null) vals.push(v); });
  const ymax = Math.max(1, ...vals) * 1.05;
  const X = (m: number) => L + ((m - 1) / (K - 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - v / ymax) * (H - T - B);
  const path = (ys: (number | null)[]) => {
    let d = "", pen = false;
    ys.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(i + 1).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  let area = "";
  if (band) {
    const idx = band.p10.map((v, i) => (v != null && band.p90[i] != null ? i : -1)).filter((i) => i >= 0);
    if (idx.length > 1) {
      area = idx.map((i, j) => `${j ? "L" : "M"}${X(i + 1).toFixed(1)},${Y(band.p10[i] as number).toFixed(1)}`).join("")
        + [...idx].reverse().map((i) => `L${X(i + 1).toFixed(1)},${Y(band.p90[i] as number).toFixed(1)}`).join("") + "Z";
    }
  }
  const yt = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }} role="img" aria-label={label}>
      {yt.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="#e4e4e7" />
          <text x={L - 4} y={Y(v) + 3} fontSize={10} textAnchor="end" fill="#52525b">{n0(v)}</text>
        </g>
      ))}
      {[1, 12, 24, 36, 48].filter((m) => m <= K).map((m) => (
        <text key={m} x={X(m)} y={H - 12} fontSize={10} textAnchor="middle" fill="#52525b">{m}</text>
      ))}
      <text x={(L + W - R) / 2} y={H - 1} fontSize={10} textAnchor="middle" fill="#52525b">months on production</text>
      {area && <path d={area} fill="#a1a1aa" opacity={0.3} />}
      {band && <path d={path(band.p50)} fill="none" stroke="#52525b" strokeWidth={1.5} strokeDasharray="4 3" />}
      {chart.forecast.map((f) => (
        f.tier === "provisional"
          ? <path key={f.location_id} d={path(f.cum_per_kft)} fill="none" stroke="#d97706" strokeWidth={1.2} strokeDasharray="5 2" opacity={0.9} />
          : <path key={f.location_id} d={path(f.cum_per_kft)} fill="none" stroke="#2563eb" strokeWidth={1} opacity={0.8} />
      ))}
    </svg>
  );
}

// D59 condition 3 for one coverage group: measured bias, the haircut (D62 target + D92 realised), the held-out bias,
// and for the step-9c groups D100's disclosed bias (= tuning bias) with its frozen D99 interval; then the D69 range.
function GroupDisclosure({ g, multi }: { g: BoxGroup; multi: boolean }) {
  const d92 = g.haircut_method.method != null && !g.haircut_method.method.startsWith("none");
  const has9c = g.disclosure.some((d) => d.disclosed_bias != null);
  const prov = g.tier === "provisional";
  const fail = prov && !!g.holdout_failed;
  return (
    <>
      <h4>
        Measured bias and haircut (D59 condition 3){multi ? ` — ${g.label}` : ""}
        {prov && <> <span className={`box-prov-badge${fail ? " fail" : ""}`}>PROVISIONAL{fail ? " · HOLDOUT FAILED" : ""}</span></>}
      </h4>
      {prov && <ProvisionalDisclosure g={g} />}
      <table className="box-tbl">
        <thead>
          <tr><th>stream</th><th>horizon</th><th>measured bias{has9c ? " (raw box_v2)" : ""}</th><th>packages</th><th>{d92 ? "D62 target" : "haircut applied"}</th>
            {d92 && <th>realised (D92, median · P10–P90)</th>}
            {has9c && <th>disclosed bias ({g.disclosure[0]?.record_variant ?? g.spec}, D100)</th>}
            <th>held-out bias{prov ? (fail ? " (one-time D99, FAILED)" : " (none, D105)") : has9c ? " (9b)" : " after"}</th>{has9c && <th>D99 interval</th>}<th>F(k) (published, not applied)</th></tr>
        </thead>
        <tbody>
          {g.disclosure.map((d) => (
            <tr key={`${d.stream}${d.horizon}`}>
              <td>{d.stream}</td><td>{d.horizon}</td><td>{pct(d.measured_bias)}</td><td>{n0(d.packages)}</td>
              <td>×{d.haircut.toFixed(3)}</td>
              {d92 && <td>×{d.realised_median?.toFixed(3) ?? "—"} · {d.realised_p10?.toFixed(3) ?? "—"}–{d.realised_p90?.toFixed(3) ?? "—"}</td>}
              {has9c && <td><strong>{pct(d.disclosed_bias)}</strong></td>}
              <td className={fail ? "box-hold" : undefined}>
                {fail && d.holdout_bias_after == null && d.disclosed_bias != null ? "no holdout packages" : pct(d.holdout_bias_after)}
              </td>
              {has9c && <td>{d.d99_interval ? `${pct(d.d99_interval[0])} … ${pct(d.d99_interval[1])}` : (prov ? "not judged" : "not judged in 9b")}</td>}
              <td>{g.calendar_factor[d.stream]?.[d.horizon.replace("cum-", "")]?.toFixed(3) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d92 && (
        <div className="count" style={{ margin: "2px 0 0" }}>
          Realised = cumulative factor the volumes actually carry, across the group's covered PUDs (P10 = high). After month 48 the
          rate factor holds at ×{g.haircut_method.tail?.oil?.toFixed(3) ?? "—"} oil / ×{g.haircut_method.tail?.gas?.toFixed(3) ?? "—"} gas;
          this pad's per-location EUR factor is the "EUR haircut" column below.
        </div>
      )}
      {!d92 && g.haircut_method.method?.startsWith("none") && (
        <div className="count" style={{ margin: "2px 0 0" }}>No haircut: {g.haircut_method.method}.</div>
      )}
      {g.radius_ranges.length > 0 && (
        <>
          <h5 style={{ margin: "6px 0 2px" }}>Measured package range for this pad's analog radius (D69; {g.radius_basis})</h5>
          <table className="box-tbl">
            <thead><tr><th>analog radius</th><th>horizon</th><th>80 % of packages within</th><th>packages</th></tr></thead>
            <tbody>
              {g.radius_ranges.map((x) => (
                <tr key={`${x.radius_class}${x.horizon}`}>
                  <td>{x.radius_class}</td><td>{x.horizon}</td><td>{pct(x.low, 0)} … {pct(x.high, 0)}</td><td>{x.packages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

// D105 provisional tier: why the bench is provisional, its holdout status, and the step-15 lines (bias with
// its 95 % range) per label × stream × horizon. Scope columns run lead first, then the holdout, so on a
// holdout-FAILED bench the holdout figure always sits beside the pooled one — never the pooled figure alone.
function ProvisionalDisclosure({ g }: { g: BoxGroup }) {
  const lines = g.lines ?? [];
  const fail = !!g.holdout_failed;
  const scopes = [...new Set(lines.map((l) => l.scope))].sort((a, b) => rank(a) - rank(b));
  function rank(s: string) {
    if (s === g.lead?.scope) return 0;
    if (s === "holdout") return 1;
    return 2;
  }
  const key = (l: BoxTierLine) => `${l.label}|${l.stream}|${l.horizon}`;
  const rows = new Map<string, { label: string; stream: string; horizon: number; by: Record<string, BoxTierLine> }>();
  for (const l of lines) {
    const r = rows.get(key(l)) ?? { label: l.label, stream: l.stream, horizon: l.horizon, by: {} };
    r.by[l.scope] = l;
    rows.set(key(l), r);
  }
  const ordered = [...rows.values()].sort((a, b) =>
    (a.label === g.lead?.label ? 0 : 1) - (b.label === g.lead?.label ? 0 : 1)
    || a.label.localeCompare(b.label) || (a.stream === "oil" ? 0 : 1) - (b.stream === "oil" ? 0 : 1) || a.horizon - b.horizon);
  return (
    <div className={`box-prov${fail ? " fail" : ""}`}>
      <div className="count" style={{ margin: 0 }}>
        <strong>{g.tier_label ?? "provisional tier (D105)"}</strong>. Holdout: {g.holdout ?? "none"}. Raw box_v2, no haircut.
        {g.lead ? ` Lead line: ${g.lead.label}, ${g.lead.scope}.` : ""}
        {g.latest_vintage_text ? ` ${g.latest_vintage_text[0].toUpperCase()}${g.latest_vintage_text.slice(1)}.` : ""}
      </div>
      {ordered.length > 0 && (
        <table className="box-tbl">
          <thead>
            <tr>
              <th>line</th><th>stream</th><th>horizon</th>
              {scopes.map((s) => <th key={s}>bias, {s}{s === g.lead?.scope ? " (lead)" : ""} · 95 % range · packages</th>)}
            </tr>
          </thead>
          <tbody>
            {ordered.map((r) => (
              <tr key={`${r.label}${r.stream}${r.horizon}`}>
                <td>{r.label}</td><td>{r.stream}</td><td>cum-{r.horizon}</td>
                {scopes.map((s) => {
                  const l = r.by[s];
                  return (
                    <td key={s} className={s === "holdout" ? "box-hold" : undefined}>
                      {l ? <><strong>{pct(l.bias)}</strong> · {l.range_95 ? `${pct(l.range_95[0])} … ${pct(l.range_95[1])}` : "—"} · {l.packages}</>
                        : s === "holdout" && fail ? "no holdout packages" : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="count" style={{ margin: "2px 0 0" }}>
        Bias = {g.error_convention ?? "actual ÷ forecast − 1 (negative = forecast HIGH)"}.
        {fail ? " This bench FAILED its one-time holdout: quote the holdout figure with the pooled one, never the pooled figure alone." : ""}
      </div>
    </div>
  );
}
