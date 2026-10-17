import { useEffect, useState } from "react";

import { COVERAGE_LABELS, fetchBoxPad, type BoxGroup, type BoxPad, type BoxPadLocation } from "../api/highgrade";

// BOX workup for one Highgrade pad, rendered on demand from box.* (D80: the database
// is the record, pages are renders). Same content as engineering_db's committed pad
// pages (box/production_pages.py): method statement + measured bias / haircut (D59
// condition 3), radius-class range (D69), locations, forecast vs analog actuals, the
// named analogs. Plus the Novi number next to each BOX one (the toggle's comparison).

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
  const covered = data.locations.filter((l) => l.coverage === "covered");
  const others = data.locations.filter((l) => l.coverage !== "covered");
  const byClass = others.reduce<Record<string, number>>((a, l) => ({ ...a, [l.coverage]: (a[l.coverage] ?? 0) + 1 }), {});

  return (
    <div className="box-wu">
      <div className="count" style={{ margin: 0 }}>
        BOX run {r.run_id} · spec {groups.map((g) => g.spec).filter((v, i, a) => a.indexOf(v) === i).join(" + ")} · code {r.code_sha.slice(0, 7)} · boxfit {r.engine_sha?.slice(0, 7)} ·
        deal-intake config v{r.dealintake_config} · Novi {r.report_version} · production through {r.data_through} ·
        {" "}{covered.length} covered of {data.locations.length} PUDs · {data.analogs.length} named analogs
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
            WCXY none, D97). Volumes
            are <strong>uptime-free</strong> (D63); oil + gas only, no water (D72); EUR = raw 50-yr technical integral, no
            economic limit. Error = actual ÷ forecast − 1 (negative = the method forecast HIGH).
          </div>
          {groups.map((g) => <GroupDisclosure key={g.group} g={g} multi={groups.length > 1 || g.group !== "WCA"} />)}
        </>
      )}

      <h4>Locations — BOX vs Novi</h4>
      <LocationsTable rows={[...covered, ...others]} />

      {data.chart && (
        <>
          <h4>Forecast vs analog actuals (oil, cumulative per 1,000 ft)</h4>
          <Chart chart={data.chart} />
          <div className="count" style={{ margin: "2px 0 0" }}>
            Blue = each covered location's forecast (P50 × haircut, uptime-free). Grey = the named analogs' ACTUAL calendar
            cumulative per 1,000 ft: P10 (high) – P90 (low) band and P50, months with ≥ 3 analogs reporting
            ({data.chart.n_analog_curves} analogs). Calendar actuals carry downtime; the forecast does not (D63).
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
    </div>
  );
}

function LocationsTable({ rows }: { rows: BoxPadLocation[] }) {
  return (
    <table className="box-tbl">
      <thead>
        <tr>
          <th>stick</th><th>bench</th><th>BOX coverage</th><th>lateral ft</th><th>spacing ft</th><th>analogs · radius</th>
          <th>BOX oil EUR bbl</th><th>EUR haircut</th><th>BOX oil /kft</th><th>Novi oil /kft</th><th>BOX ÷ Novi</th><th>oil cum-12</th>
          <th>oil Di nom (1-yr eff) · b</th><th>BOX gas EUR mcf</th><th>flags</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => {
          const cov = l.coverage === "covered";
          const ratio = cov && l.oil_eur_per_kft && l.novi_oil_eur_per_kft ? l.oil_eur_per_kft / l.novi_oil_eur_per_kft : null;
          return (
            <tr key={l.stick_id} className={cov ? "" : "nc"}>
              <td title={l.unique_id}>{l.stick_id}</td>
              <td>{l.formation_blueox}</td>
              <td>{cov ? "covered" : COVERAGE_LABELS[l.coverage] ?? l.coverage}</td>
              <td>{n0(cov ? l.lateral_ft : l.ll_ft)}</td>
              <td>{cov ? `${n0(l.planned_spacing_ft)}${l.spacing_source === "default_880" ? " (default)" : ""}` : ""}</td>
              <td>{cov || l.n_analogs != null ? `${l.n_analogs ?? "—"} · ${l.radius_mi?.toFixed(1) ?? "—"} mi${l.search_mode === "strike" ? " strike" : ""}` : ""}</td>
              <td>{cov ? n0(l.oil_eur) : "not covered"}</td>
              <td>{cov && l.oil_haircut != null ? `×${l.oil_haircut.toFixed(3)}` : ""}</td>
              <td>{cov ? n0(l.oil_eur_per_kft) : ""}</td>
              <td>{n0(l.novi_oil_eur_per_kft)}</td>
              <td>{ratio == null ? "" : `${ratio.toFixed(2)}×`}</td>
              <td>{cov ? n0(l.oil_cum12) : ""}</td>
              <td>{cov && l.oil_di_nominal != null
                ? `${l.oil_di_nominal.toFixed(2)}/yr (${((l.oil_di_eff_1yr ?? 0) * 100).toFixed(0)}%) · ${l.oil_b?.toFixed(2) ?? "—"}`
                : ""}</td>
              <td>{cov ? n0(l.gas_eur) : ""}</td>
              <td className="box-flags">{(l.flags ?? []).join("; ")}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Chart({ chart }: { chart: NonNullable<BoxPad["chart"]> }) {
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
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W }} role="img" aria-label="BOX forecast vs analog actuals">
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
        <path key={f.location_id} d={path(f.cum_per_kft)} fill="none" stroke="#2563eb" strokeWidth={1} opacity={0.8} />
      ))}
    </svg>
  );
}

// D59 condition 3 for one coverage group: measured bias, the haircut (D62 target + D92 realised), the held-out bias,
// and for the step-9c groups D100's disclosed bias (= tuning bias) with its frozen D99 interval; then the D69 range.
function GroupDisclosure({ g, multi }: { g: BoxGroup; multi: boolean }) {
  const d92 = g.haircut_method.method != null && !g.haircut_method.method.startsWith("none");
  const has9c = g.disclosure.some((d) => d.disclosed_bias != null);
  return (
    <>
      <h4>Measured bias and haircut (D59 condition 3){multi ? ` — ${g.label}` : ""}</h4>
      <table className="box-tbl">
        <thead>
          <tr><th>stream</th><th>horizon</th><th>measured bias{has9c ? " (raw box_v2)" : ""}</th><th>packages</th><th>{d92 ? "D62 target" : "haircut applied"}</th>
            {d92 && <th>realised (D92, median · P10–P90)</th>}
            {has9c && <th>disclosed bias ({g.disclosure[0]?.record_variant ?? g.spec}, D100)</th>}
            <th>held-out bias{has9c ? " (9b)" : " after"}</th>{has9c && <th>D99 interval</th>}<th>F(k) (published, not applied)</th></tr>
        </thead>
        <tbody>
          {g.disclosure.map((d) => (
            <tr key={`${d.stream}${d.horizon}`}>
              <td>{d.stream}</td><td>{d.horizon}</td><td>{pct(d.measured_bias)}</td><td>{n0(d.packages)}</td>
              <td>×{d.haircut.toFixed(3)}</td>
              {d92 && <td>×{d.realised_median?.toFixed(3) ?? "—"} · {d.realised_p10?.toFixed(3) ?? "—"}–{d.realised_p90?.toFixed(3) ?? "—"}</td>}
              {has9c && <td><strong>{pct(d.disclosed_bias)}</strong></td>}
              <td>{pct(d.holdout_bias_after)}</td>
              {has9c && <td>{d.d99_interval ? `${pct(d.d99_interval[0])} … ${pct(d.d99_interval[1])}` : "not judged in 9b"}</td>}
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
