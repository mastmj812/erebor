# erebor — BOX scouting

Internal app to scout where BOX-forecast locations remain in each Permian bench. It does three things:

- **Map tab.** Color the stick locations by BOX EUR per foot, by Steven's econ, or by coverage / bench.
  Filter by bench, tier and PDP proximity. Lasso an AOI to get a BOX rollup, a gunbarrel and a production
  profile.
- **Highgrade tab.** Screen the remaining locations and aggregate a BOX metric per DSU.
- **Novi accuracy tab.** Keep Novi's forecast-vs-actual record as a reference.

The overhaul that turned erebor from the Novi Intelligence deal-valuation app into this is recorded step
by step in [`docs/overhaul_plan.md`](docs/overhaul_plan.md) (2026-10-20 → 21).

**Rules the app holds to**
- **Novi = geometry only** (Michael, 2026-10-21).
  - From Novi we use the stick locations, the 2026Q3 DSU polygons, and Novi's forecast, but only as the
    single-well comparison curve against BOX (and on the Accuracy reference tab).
  - Novi's PUD / RES tag, tiers, NPV and support scores are not read.
- **BOX = the record run** (`box.forecast_run.is_record`), read through `backend/app/box_locations.py`.
  - That module is the one place BOX attributes are read, keyed by `location_id`.
  - Every location carries a coverage class. A location without a forecast is shown and counted by class,
    never valued as zero (D2 / D67).
  - PROVISIONAL benches are always labelled and counted apart (D105).
- **Econ is Steven's** (`box_econ.box_pud_econ`), for the record run only.
  - One deck at a time (default WTI $70 / HH $3), shown with its provenance.
  - Display only: erebor computes no economics (D13).
- **The AOI production profile is a cohort MEAN per 1,000 ft, never a P50.**

## Architecture

```
engineering_db (Supabase oilgas warehouse, read-only from here)
  curated.erebor_locations   stick locations (Novi geometry) + curated PDP horizontals
  curated.intel_pad_member / intel_pad_geom   Novi 2026Q3 DSU polygons (sql/67)
  box.* (record run)  +  box_econ.box_pud_econ (Steven)
  curated.intel_forecast / intel_arps   Novi forecast: comparison curve + Accuracy only
        │  (read-only, DATABASE_URL → Supavisor :6543, per-transaction READ ONLY)
        ▼
backend/ (FastAPI, :8077)  ──proxied /api──▶  frontend/ (React + MapLibre + Zustand, Vite :5180)
        │ imports                                   uses
   packages/decline/ (Arps math for the Novi       permian PMTiles basemap + TX/NM grid
   comparison curve's tail)                         (read from permian_type_curve)
```

- **No auth** (local / internal; same-origin Vite proxy).
- **Tests are DB-free:** `pytest -q` from the repo root.

## Run (local dev)

Prereqs:
- A Python 3.14 venv at `.venv`, with the backend deps and `decline` installed.
- Node LTS.
- A `backend/.env` with `DATABASE_URL` pointing at the Supabase `oilgas` warehouse (Supavisor transaction
  pooler, `:6543`).

```powershell
# backend (terminal 1)
cd erebor/backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8077 --reload

# frontend (terminal 2)
cd erebor/frontend
npm install        # first time
npm run dev        # http://localhost:5180  (proxies /api -> :8077)
```

## Endpoints (backend)

**Map**
- `/api/health`, `/api/basins`.
- `/api/tiles/{z}/{x}/{y}.mvt?basin=&econ=&deck=` carries BOX properties per stick and is cached in process
  (`econ` = a comma list: the econ color metric + any econ range, one `econ_<metric>` property each).
- `/api/layers/{pads,land_grid,outline}.geojson?basin=`.
- `/api/basemap/{permian.pmtiles,blocks.geojson,sections.geojson}`.

**BOX**
- `/api/box/meta?basin=`: record run, disclosure, priced decks, coverage by class.
- `/api/box/legend?basin=&metric=[&bench=&exclude=&tier=]`: ramp breaks (P5–P95) over the forecast locations on the
  benches and tiers the map shows.
- `/api/box/location?basin=&stick_id=`: the single-location workup (Map tab "Workup"): the EUR build chain, type curve
  vs named analogs, the cohort's flags, same-bench producers nearby NOT in the cohort, and same-bench BOX neighbours.
- `/api/box/pad?basin=&pad_key=`: the per-DSU workup, with named analogs, the BOX÷Novi cross-check, and
  forecast vs analog actuals.

**Selection**
- `POST /api/select` (AOI → per-stick BOX values + one econ deck).
- `POST /api/select/deals` (deal shapefile / gpkg upload, display only).
- `POST /api/gunbarrel`.
- `POST /api/production/box_profile` (AOI mean per 1,000 ft + sum, by bench).
- `/api/production/well?basin=&name=` (single well: BOX vs Novi).

**Highgrade**
- `/api/highgrade/facets?basin=&deck=`.
- `POST /api/highgrade/pads`.
- `POST /api/highgrade/gunbarrel`.

**Novi accuracy (reference; `curated.intel_forecast_accuracy`, engineering_db sql/38)**
- `/api/accuracy/{vintages,wells,summary,grid,well}`.
- `POST /api/accuracy/selection`.

## History

- **2026-06 → 09: built as the Novi Intelligence deal-valuation app.**
  - Phase 0: data discovery (`SCHEMA.md`, a reference for Novi's raw files).
  - Phases 1–4.5: map, AOI selection, value rollup, gunbarrel + production, culling.
  - Phase 5: the xlsx export.
  - Then the Accuracy and Highgrade tabs.
- **2026-10-20 → 21: overhaul to BOX scouting** (`docs/overhaul_plan.md`).
  - The xlsx export and every Novi value screen were removed.
  - Highgrade moved to the 2026Q3 DSU polygons.
  - A BOX hindcast for the Accuracy tab is deferred (step 7).
