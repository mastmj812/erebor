# erebor — Novi Intelligence deal-valuation app

Internal app to value Permian acquisitions from Novi Intelligence: define an AOI,
get every Novi stick inside it by category (PDP / PUD / RESOURCE), turn formations
off for depth-limited deals, screen the economics, and export streams for the
authoritative cash-flow model.

## Architecture (v1)

```
engineering_db (host Postgres, oilgas DB)
  curated.intel_locations / intel_arps / intel_forecast   <-- Workstream A
        │  (read-only, DATABASE_URL)
        ▼
backend/ (FastAPI, :8077)  ──proxied /api──▶  frontend/ (React + MapLibre, Vite :5180)
        │ imports                                   uses
   packages/decline/ (shared Arps/EUR math)    permian PMTiles basemap (reused)
```

- **Data layer** lives in `engineering_db` (`raw_novi_intel` → `curated.intel_*`); erebor reads it
  directly via `DATABASE_URL` (single env var — re-point at a hosted warehouse for deployment).
- **Shared math** in `packages/decline/` (extracted from permian_type_curve; used in Phase 4).
- **No auth** in v1 (local/internal). Add JWT (mirror permian_type_curve) before server hosting.

## Run (local dev)

Prereqs: Python 3.14 venv at `.venv` (backend deps + `decline` installed); Node LTS; the
`oilgas` Postgres running on localhost:5432 with `curated.intel_*` built.

```powershell
# backend (terminal 1)
cd erebor/backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8077 --reload

# frontend (terminal 2)
cd erebor/frontend
npm install        # first time
npm run dev        # http://localhost:5180  (proxies /api -> :8077)
```

Open http://localhost:5180.

## Status by phase

- Phase 0 — data discovery → `SCHEMA.md`. ✅
- Workstream A — Novi Intelligence in engineering_db (248,618 sticks, 73.9M forecast rows). ✅
- Workstream B — shared `decline` package, 10/10 tests. ✅
- **Phase 1 — Map view.** Backend MVT tiles + GeoJSON overlays + basemap; frontend basin switcher,
  PDP/PUD/RES toggles, formation coloring + legend, pad/grid/outline overlays, hover popups. ✅
  - Deferred: land-grid section *labels* (grid renders as lines; Novi's grid attribute schema not
    yet mapped to a label field).
- **Phase 2 — AOI selection.** Backend `/api/select` (polygon) + `/api/select/shapefile`
  (upload→reproject via pyproj) over `curated.intel_locations`, with the intersects-vs-midpoint
  rule. Frontend lasso/box draw, shapefile upload, rule toggle (re-runs on the current AOI),
  yellow feature-state highlight of selected sticks, AOI outline, and a results panel
  (counts by category / formation / pad). ✅
- **Phase 3 — formation filter + value rollup (screen).** `/api/select` returns per-(category,
  formation) NPV (all discount rates) + EUR sums + the price deck. Frontend: include/exclude
  formation checklist + discount-rate selector that recompute the rollup live (and drive the map
  filter); per-bucket + combined NPV, future-location count, price-deck assumptions, screening
  caveat. ✅
- Phase 4 — gunbarrel + production plots. ⏳
- Phase 5 — export (authoritative). ⏳

## Endpoints (backend)

`/api/health`, `/api/basins`, `/api/tiles/{z}/{x}/{y}.mvt?basin=`, `/api/layers/{pads,land_grid,
outline}.geojson?basin=`, `/api/basemap/permian.pmtiles` (range-served).
