# erebor overhaul — BOX-first scouting platform (stepped, gated)

> Agreed with Michael 2026-10-20. This file is the record: each step's PR updates **Status** below.

## Status
| Step | State | Where |
|---|---|---|
| 1 Warehouse 3Q26 pads → `intel_pad_geom` v3 | code merged (engineering_db #173); **live load pending** (after step 2 merges, Delaware drop back on SharePoint) | engineering_db `sql/66`, `sql/67` |
| 2 Remove export; Accuracy = Novi reference; pin pad vintage | this PR | erebor |
| 3–6 | not started | |
| 7 BOX hindcast | deferred | |


## Context
erebor was built to show Novi Intelligence PUD locations and Novi forecasts. Novi's forecasts were judged
ill-fit (inflated tails, thin-support bias). They are being replaced by BOX: in-house analog type curves,
record = `box.forecast_run` run 14 (`is_record`), Delaware only.

Michael's direction (2026-10-20): erebor becomes a platform to scout where economic locations remain in
each bench.
- Filter by bench.
- Color the map by BOX EUR/ft or by Steven's econ columns.
- Highgrade works as it does today, but aggregates BOX values (EUR or econ) instead of Novi.

**Scope rule (D13):** econ is Steven's `box_econ.box_pud_econ`. erebor only displays it, with provenance,
and computes no economics.

**Live facts (read-only, 2026-10-20)**

Run 14 PUDs, by coverage:

| Coverage | PUDs | Benches |
|---|---|---|
| covered (validated) | 17,820 | WCA, BS2_S, WCB_1, WCC |
| covered_provisional | 24,655 | AVA_0/1/2, BS1_S, BS2_C, BS3_C/S, WCB_2 |
| not_covered_outside_extent | 56,502 | |
| not_covered_emerging | 13,782 | includes every Midland PUD (4,154) |
| not_covered_no_precedent | 8,488 | |
| not_covered_no_analogs | 480 | |

- 9,706 PUDs carry the proximity oil haircut (×0.75–0.94, D113). It is already inside the stored EUR.
- `box_pud_econ` holds run 10 only: 50,963 locations × 16 decks (WTI 60/70/80/90 × HH 1–4).
- Run 14 has not been priced yet.

**Pads**
- Highgrade today aggregates on *derived* pads: `curated.intel_pad_geom`, built by sql/46 as a hull of
  member sticks + 330 ft.
- The map's Pads overlay still reads the 2025Q3 shapefile (`raw_novi_intel.pads`).
- Novi has now shipped the 3Q26 pad polygons for both basins (same 2026Q3 vintage as the warehouse):
  - Delaware: 8,256 single-part polygons, max 2,873 ac.
  - All 7,778 live Delaware pad_names are present.
  - 94% of named sticks lie inside their own polygon.
  - Every outlier is a WDFD name-reuse stray.
- 3Q26 ships no land grid or outline, so those overlays stay on 3Q25.

## Long-run direction (Michael, 2026-10-20; not this overhaul)
**Goal:** BOX-derived locations replace the Novi sticks, by infilling the Novi DSU polygons narvi-style,
for both basins.

**Why the DSU bounding geometry matters:** it sets the infill geometry. The alternative is deriving our own
DSUs that tile the basin.

**What this overhaul does about it:**
1. Step 1 loads **every** 3Q26 DSU polygon into the warehouse, including the 3,772 Delaware polygons with
   WellCnt = 0. Those carry no Novi stick but are still DSU extents the infill will need. The raw table is
   the DSU geometry of record. `intel_pad_geom` is only the stick-membership view used for Highgrade
   aggregation.
2. erebor reads every BOX attribute by `location_id`, through one module (`box_locations.py`), never by
   Novi `stick_id`. Swapping Novi sticks for BOX-derived locations later then touches that module and the
   tile geometry source, not every panel.
3. The map feature id stays `stick_id`, keeping the sign convention (rule 8, `promoteId`), while BOX
   locations are still Novi sticks. Re-keying it is a decision for the later workstream; it is flagged
   there, not made here.

## Decisions (agreed 2026-10-20)
1. **Novi role.** BOX is the only forecast and econ source on the map and in Highgrade.
   - Novi survives only as the location universe: sticks, pad_name, recon status, geometry.
   - It also survives as the BOX÷Novi cross-check column inside the pad workup.
   - Novi NPV and its three caveats go away.
2. **Econ = record run only.** Until Steven pushes run 14, econ shows as "not yet priced on run 14"
   everywhere. Run-10 dollars never appear on run-14 volumes.
3. **Econ display.** Deck picker over Steven's decks, default WTI 70 / HH 3, default metric PV10.
   - Metrics: PV0–30, IRR, breakeven WTI@PV20, capex.
   - erebor computes no "economic" flag. You threshold with range filters.
4. **xlsx export: removed.** A future export is a new design.
5. **Accuracy tab: kept as the Novi reference.** A BOX hindcast version is a later, separate step that
   needs a warehouse matview first.
6. **Not-covered PUDs: hidden by default on the map.**
   - A toggle shows them grey, with "Not covered: <reason>".
   - They are never colored as zero and never valued.
   - Highgrade and the selection rollup keep per-class counts (D2/D67).
7. **Novi screens removed.**
   - Tier chips: rqt, spacing_t, deplet_t, complet_t.
   - The "Drillable only" gate and the depletion and support color modes.
   - The `tvd_excess` default and the PDP-support count.
8. **Pads switch to Novi's 3Q26 polygons, warehouse-side.** Membership rule:
   - `pad_key = pad_name` when the stick lies inside its named Novi polygon (+330 ft tolerance).
   - Same-name strays fall back to today's derived "[k/n]" hull split.
   - `geom_source` says which applies.
9. **Lasso selection.** Shows a BOX rollup, the gunbarrel (colorable by BOX), and an AOI BOX profile:
   the mean per-1,000-ft monthly curve by bench, labeled mean (not P50).
10. **Midland stays**, with a banner: "BOX does not forecast Midland yet". It lights up automatically
    once a record run covers it.
11. **Kept unchanged.**
    - Deal-geometry uploads (display-only, rule 13).
    - PDP sticks as context.
    - The single-well BOX/Novi curve on click.
    - The gunbarrel sign rule v2 (`_canonical_axis` ×3).
12. **Plan home.** `docs/overhaul_plan.md` in erebor, committed with the step-2 PR. Each step's PR ticks
    its gate.

## Steps
One PR per step and one branch per repo per step; never stack PRs. **Stop after each step**: report what
exists and how to verify it, then wait for Michael's go.

### Step 1 — Warehouse: 3Q26 Novi pad polygons → `intel_pad_geom` v3 (engineering_db)
- **Loader** (`etl/novi_intel/paths.py`, `load_shapefiles.py`):
  - Make the version per layer: pads 2026Q3, grid/outline stay 3Q25.
  - Resolve the nested `*Pad*Summary*Mid_Cycle*.zip` inside the 3Q26 shapefile zips. The Delaware and
    Midland names differ. Strip and Mid-Cycle geometry is identical.
  - Read `padName` and the `NPV*_Sum` fields.
  - Load raw as-is: `raw_novi_intel.pads`, report_version '2026Q3', idempotent per (basin, version).
    3Q25 rows are kept.
  - Load **all** polygons, WellCnt = 0 included. They are the future DSU-infill geometry.
  - Verify the polygon count equals the shapefile record count per basin (Delaware 8,256).
- **sql/66 `intel_pad_member` + `intel_pad_geom` v3** (supersedes sql/46, which becomes a tombstone note):
  - Membership by name + inside the 2026Q3 polygon (+330 ft); strays use sql/46's DBSCAN fallback.
  - Same output columns: `basin, pad_key, pad_name, n_parts, geom, acres` plus `geom_source`
    ∈ {`novi_2026q3`, `stick_hull_330ft`}.
  - Consumers keep working: erebor Highgrade, deal-intake `pad_iou` (advisory; fix its stale "Midland
    only" docstring), and `thresholds.yaml`.
  - UNIQUE index (CI lint). `extensions.*` qualified. Quarterly-only, not in the nightly.
- **Apply script:** extend `scripts/apply_intel_pad_geom.py`.
- **Verify by identity:**
  - Member rows == padded sticks with geometry, and every stick has exactly one pad_key.
  - geom rows == distinct keys.
  - `geom_source` mix, acres P99/max, all polygons valid.
- **Docs:** update sql/31 comments and regenerate the data dictionary. Add the loader step to the
  `novi-quarterly-reload` skill.
- **Gate:** the PR's `etl` check is green → **explicit go for the live load + apply (Supabase write)** →
  verified live → stop.

### Step 2 — erebor: remove the export; relabel Accuracy (small, isolated)
- **Delete** `backend/app/exports/` (`data.py`, `xlsx_builder.py`), the `/api/export` route, the
  ResultsPanel export button, `api/export.ts`, `tests/test_xlsx_export.py`, and `tests/test_money_eur.py`.
  - test_money_eur pins the *Novi* exported EUR. Removing it is flagged here, and his go on this step is
    the approval.
- **Accuracy:** tab label becomes "Novi accuracy (ref)" with a reference-only caveat.
  - *Changed while building step 2:* the `/accuracy/well` frame stays on `raw_novi_intel.pads`, pinned to
    the newest loaded vintage, instead of moving to `intel_pad_geom`. The reason: accuracy wells are blind
    producers, often in DSUs with no remaining Novi stick. `intel_pad_geom` holds only pads that have
    sticks, while the raw 2026Q3 table holds every DSU.
  - The Pads overlay is pinned the same way (`app/novi_pads.py`), so 3Q25 and 2026Q3 never draw together.
- **Commit** `docs/overhaul_plan.md`.
- **Verify:** pytest green with the new count stated, tsc clean, app loads, Accuracy still works.
- **Gate:** stop.

### Step 3 — Map tab, BOX-first
**Backend**
- New shared module `backend/app/box_locations.py`: the record run, the per-stick BOX projection, and
  econ on the record run only. It reuses and moves `box_joins`, `econ_join`, `coverage_sql`, `record_run`
  and `COVERAGE_CLASSES` from `api/box.py`.
- `tiles.py` MVT:
  - Drop `npv25`, `oil_eur`, `deplet_t`, `pdp_count_3mi`, `inflation_ratio`.
  - Add for PUD rows: `coverage`, `tier`, oil/gas/water EUR per ft, `prox_outcome`, `prox_factor`,
    `lateral_ft`.
  - Add econ for `?deck=` (pv0–30, irr, be_wti_pv20, capex). It is null when unpriced.
  - All BOX properties are null on PDP rows (rule 8).
- `/api/box/meta` adds `econ_status` (priced | not_yet_priced_on_run_N) and per-basin quantile breaks per
  metric, used by the legend.

**Frontend**
- Color modes: bench (`formation_blueox`), coverage/tier, BOX oil/gas/water EUR per ft (bbl/ft, mcf/ft),
  econ metric with a deck picker.
- Unpriced and not-covered sticks are grey, never on the ramp.
- Filters:
  - Bench chips by `formation_blueox`, grouped by BOX pool (WCA = WCA_1/WCA_2/WCXY).
  - Coverage toggle; not-covered is off by default.
  - Proximity outcome.
  - EUR/ft range and econ range.
- Hover popup and legend rewritten for BOX. The Midland banner appears when the record run has no
  coverage in the basin.
- Pads overlay → the 2026Q3 DSU polygons: all of them, including DSUs with no remaining stick, so the
  map shows the infill frame. Remove the 3Q25 read.
- **Novi RES sticks:** RES is not in the BOX universe (D1/D67). It shows only under the not-covered
  toggle, as "not in BOX universe (RES)". Michael confirms at this gate.

**Quality checks**
- MVT null properties use `has`/`coalesce`.
- `zoom` expression stays outermost.
- Tile timing measured at z7 and z11 on a Delaware view.
- Layer verified rendering in the browser pane.

**Tests:** DB-free SQL-shape and projection tests in the `test_highgrade_box.py` style.

**Gate:** stop.

### Step 4 — Lasso selection workflow on BOX
- `/api/select` rollup:
  - Counts by coverage, tier and bench, with not-covered counts listed and never valued.
  - Sum and avg of BOX EUR; lateral-weighted EUR/ft.
  - Econ sums and avgs for the chosen deck on the record run; IRR and breakeven shown as median only.
- ResultsPanel rewritten. The Novi NPV rollup and the flat-deck text are removed.
- Gunbarrel (`gunbarrel.py`): colors gain BOX EUR/ft and econ. Remove the Novi `remaining_only` /
  `exclude_depleted` options.
- `/production/aggregate` replaced by a BOX AOI profile:
  - The mean `pud_forecast_month` volume per 1,000 ft, by bench, from covered + provisional PUDs.
  - Provisional is drawn dashed and the profile is labeled "mean", never P50.
- **Gate:** stop.

### Step 5 — Highgrade, BOX-only
- Remove the source toggle (`hgSource`), the Novi metrics, the Novi NPV header caveat, the tier chips, the
  Drillable gate, the depletion defaults, the `tvd_excess` default and `npv25`. This also kills the
  stale-metric-after-tab-switch bug.
- Metrics:
  - BOX oil/gas/water EUR and EUR/ft, and well count.
  - PV0–30: sum, avg or per acre.
  - IRR and breakeven: median per pad.
- Keep: coverage and tier counts, proximity chips, grey not-covered pads, the BOX workup modal (with its
  BOX÷Novi column), and the run and econ provenance notes.
- Replace the stale depletion-tier text (`HighgradePanel.tsx:109-111`, `:299-304`, `DEPLET_HINT`) with the
  run-14 statement: "Offset depletion enters BOX two ways: through the named analogs, and for
  multi-parent PUDs as an explicit oil haircut (D113). Unprecedented configurations get no forecast
  (D114)."
- Fix the hardwired "The table is WCA's".
- Pads come from v3 geometry automatically (step 1).
- **Gate:** stop.

### Step 6 — Cleanup + docs
- Remove dead Novi code: the `npv*`/`pv*` paths, the depletion and support count endpoints if unused,
  `colorForDepletion` and similar, and `settings.report_version`.
- Fix the stale docstrings listed in the inventory.
- `pyproject` description becomes "BOX scouting".
- Update the erebor rows of `C:\Users\MichaelMast\Projects\CLAUDE.md`: role, test count, the
  "three NPV caveats" sentence (now moot), and the export quality bar.
- **Gate:** stop.

### Step 7 (deferred, own plan) — BOX hindcast on the Accuracy tab
- Needs a warehouse BOX-accuracy matview first (cross-repo, warehouse first).
- Scoped only when Michael asks.

## Verification (every erebor step)
- `pytest -q` from the repo root stays green and DB-free; the count is stated.
- `npx tsc` clean under strict.
- Backend started directly (uvicorn :8077; restart after any `packages/decline` edit) and frontend :5180.
  The affected tab is exercised in the browser pane.
- Live warehouse smoke of the new SQL: read-only, under the transaction-GUC pattern.
- New SQL whitelists identifiers and binds values.
- Not-covered is never zero, and provisional is always labeled.
- Econ appears only for `is_record` with provenance (run, deck, assumption set, built/pushed at).

## Critical files
- **erebor backend:** `backend/app/api/{tiles,box,highgrade,select,gunbarrel,production,layers,accuracy,export}.py`,
  `backend/app/exports/`, and `tests/test_highgrade_box.py`.
- **erebor frontend:** `src/store.ts`, `src/map/sticksLayers.ts`, `src/MapView.tsx`,
  `src/panels/{Controls,Legend,ResultsPanel,HighgradePanel,BoxWorkup,ProductionPanel,GunbarrelView,TabSwitcher}.tsx`,
  and `src/api/{highgrade,select,production,export}.ts`.
- **engineering_db:** `etl/novi_intel/{paths,load_shapefiles}.py`, `sql/46_intel_pad_clusters.sql` → `sql/66`,
  `scripts/apply_intel_pad_geom.py`, `dealintake/warehouse.py:216`, and the `novi-quarterly-reload` skill.
