# SCHEMA.md — Novi Intelligence (3Q25) Verified Data Dictionary

Status: **Phase 0 discovery complete.** Verified by inspecting the actual Delaware + Midland
3Q25 files (DBF attribute tables, CSV headers + sample rows, xlsx sheet list). Items marked
**(VERIFY)** need the forthcoming Novi data dictionary (shipping with the Intelligence API) or a
deeper pass to confirm.

CRS for **all** shapefiles: **EPSG:4326 (WGS84 geographic)** — confirmed. No reprojection of
Novi layers; reprojection is only needed for user-uploaded deal shapefiles (Phase 2).

---

## 1. File inventory & roles (per basin)

| Role | Delaware | Midland | Notes |
|---|---|---|---|
| Economic sticks — producing | `PDP_Oil.zip` (22,215) | `PDP_Oil.zip` (22,517) | rich econ schema; `Unique ID` = **API10** |
| Economic sticks — undeveloped | `PUD_Oil.zip` (83,282) | `PUD_Oil.zip` (48,183) | rich econ schema; `Unique ID` = **name** |
| Economic sticks — resource | `Resource.zip` (44,674) | `Resource.zip` (27,747) | rich econ schema; `Unique ID` = **name** |
| Other ML laterals | `Other_ML_PDP/PUD_Oil.zip` | same | **minimal** schema (no econ); tier scores only |
| Rock-quality polygons | `Drilled_/Undrilled_Rock_Quality_Oil.zip` | same | scoring polygons (not valuation) |
| Pad / DSU polygons | `…(Pad Shapefile).zip` (4,606) | `Pad Shapefile With Economics.zip` (4,434) | pad-level NPV rollup; **schema differs by basin** |
| Section/block grid | `… Operated Land Grid.zip` | `… Operated Land Grid.zip` | **Novi-supplied grid — no public PLSS source needed** |
| Basin outline | `… Outline.zip` | `… Outline.zip` | map overlay |
| Well attributes | `Novi Analytics File.csv` (25 MB) | `…midland….csv` (14.5 MB) | geometry endpoints + completion design; keyed by `Well Name` |
| Arps params | `…(Arps Download).csv` (298 MB) | `…(Arps Download).csv` (174 MB) | segmented decline; keyed by `novi_wellname` |
| Production stream | `…(Forecast Production Download)(1).csv` **(4.8 GB)** | `…(2).csv` **(2.86 GB)** | ~29.5-yr monthly stream; keyed by `novi_wellname` |
| Report workbook | `…(Data Download).xlsx` (123 MB) | `….xlsx` (78 MB) | redundant econ + aggregate report sheets; **not used by app** |

The 4.8 GB / 2.86 GB streams confirm the data **must** be loaded into PostGIS (Workstream A);
no per-selection file scanning.

---

## 2. The economic "stick" schema (PDP / PUD / Resource shapefiles)

~54–56 attribute fields. Geometry = lateral LINESTRING (WGS84). Representative fields (values
from real rows):

**Identity / location**
- `Unique ID` — **PDP: API10** (`3001534505` NM, `4200343191` TX). **PUD/RES: well name**
  (`Delaware Eddy Unit 1 AMC 1`). This split is the crux of the join model (§4).
- `Phase` (`Oil`), `PUD/PDP/RE` (`PDP`/`PUD`/`RES`), `Operator`, `Formation`,
  `County` (Delaware only), `Pad Name`, `FP_Year` (first-prod year; `2050` = placeholder for
  undeveloped), `TVD`, `MD`, `LL_ft`, `Prop_Load` (lb/ft).

**Reserves / rates** (per-phase)
- `Oil_EUR` (bbl), `Gas_EUR` (mcf), `DGas_EUR` (dry gas mcf), `NGL_EUR` (bbl), `Water_EUR` (bbl).
- `Oil_IP`, `Gas_IP`, `DGas_IP`, `NGL_IP`, `Water_IP` — IP rate, per-day (VERIFY units).
- `NGL_Yield` (bbl/mmcf, VERIFY), `NGL_Shrink` (fraction).

**Economics** (Novi's pre-computed deal economics — surfaced as a *screen*, not authoritative)
- `NPV5 … NPV25` — NPV at 5–25% discount, **$** (can be negative).
- `PV5 … PV25` — PV at 5–25% (gross of cost vs NPV net — **VERIFY** exact definition).
- `NPV5_B_e … NPV25_B_e` and `1/2/3 Yr B_e` — breakeven WTI price ($/bbl) variants (**VERIFY**).
- `IRR_pct` — **units inconsistent per source-file slice** (measured): Delaware PUD & RES are
  stored as **percent** (slice median ~74–79); Delaware PDP and all Midland slices are stored as
  a **fraction** (slice median 0.32–0.65). **Resolved:** `curated.intel_locations` normalizes to
  **percent** via a self-calibrating per-(basin,category) rule — if the slice median of
  `abs(irr_pct) > 5` it is already percent, else ×100. (Safe: the fraction-vs-percent median gap
  is sub-1 vs ~75.)
- `PP_Months` (payout, months), `TTPT` (**VERIFY** — likely time-to-payout-test, months).
- `D_C_Cost` (drill & complete, $), `DCET_Cost` (D&C+equip+tie-in, $), `Norm_DC`/`Norm_DCET` ($/ft).
- Flat price deck: `WTI_Price` (75), `HH_Price` (3), `NGL_Price` (20 Del / 26 Mid),
  `WTI_Diff`, `HH_Diff`. **All sticks priced on one flat deck — this is the key driver to
  surface in the UI (Phase 3) and the reason in-app value is a screen, not the deal price.**
- `Has Econom` (`Yes`/`No` flag — exclude `No` from value rollups), `Conf_Int` (confidence score).

### Basin schema drift to normalize in curated
- Midland lacks `County`; column **order** differs (Midland puts `Pad Name` 4th, Delaware last).
- Field **types** differ (Delaware PDP `TVD/MD/LL_ft`/EUR carry decimals; Midland PDP stores them
  as integers; `Conf_Int` numeric in Delaware, text in Midland).
- Midland PDP `Pad Name` = `No Pad Name`; Delaware PDP `Pad Name` = `PDP` (both placeholders →
  PDP sticks have no usable pad key).
- Pad shapefiles: Delaware = `PadName`,`SUM_NPV25`,`NPV25 (MM)`; Midland = `Pad Name`,`NPV5…NPV25`.

---

## 3. CSV schemas

**Novi Analytics** (18 cols): `Well Name, TVD, Midpoint Lat/Lon, Bottom Hole Lat/Lon, Heelpoint
Lat/Lon, Target Formation, Lateral Length, Proppant Loading, Fluid Loading, County, Subbasin,
Proppant Mass, Fluid Volume, MD, Pad Name`. `Well Name` == `novi_wellname` == PUD/RES `Unique ID`.
Gives heel/mid/BH points for the **gunbarrel** (Phase 4) and a name↔geometry source. No API column.

**Arps** (16 cols): `job_name, well_inventory_name, planned_well_id, production_stream, segment,
segment_curve_type, b, d_nom, d_eff_secant, d_eff_tangent, q_start, q_stop, terminal_day,
day_start, day_stop, novi_wellname`.
- One row per (`novi_wellname`,`production_stream`,`segment`). `segment_curve_type` ∈
  {`hyperbolic`,`exponential`}. Segments chain by `day_start→day_stop`; the **final exponential
  segment runs to `day_stop = 18250` (= 50 yr)**. Streams: `oil`,`gas` (water VERIFY).
- Evaluate with the shared `forecasting` lib (`models.py`/`eur.py`); **do not fit** — Novi
  supplies the params. `planned_well_id` is an opaque alt-key; `well_inventory_name` =
  `… Base Case 2025/06` (the inventory snapshot tag).

**Forecast Production** (6 cols): `ip_day, novi_wellname, oil, gas, water, pad_name`.
- Sorted by `novi_wellname` then `ip_day`. **Cadence = 30-day steps; horizon ≈ 10,770 days
  (~29.5 yr), ~359 points/well** — i.e. a near-full-life **monthly** stream, *not* a 3-yr ML
  forecast as originally assumed. `oil`/`gas`/`water` are per-day rates at each step (VERIFY:
  bopd / mcfd / bwpd).

---

## 4. Join model (resolved)

```
PUD / RESOURCE (future):
  sticks.Unique ID ── novi_wellname ──> Forecast, Arps        (name key)
  sticks.Pad Name  ── Pad Name      ──> Pads                  (pad key)
  Analytics.Well Name == novi_wellname                        (geometry/heel-toe for gunbarrel)
  economics: on-stick (NPV/EUR columns)

PDP (producing):
  sticks.Unique ID == API10 ─────────> engineering_db.curated.wells / curated.production
  economics: on-stick (Novi's)         (real history by api10; authoritative producing data)
```

- **PUD/RESOURCE** join cleanly by `novi_wellname`. **(VERIFY)** that every PUD/RES `Unique ID`
  has matching rows in Forecast + Arps (spot-check during load).
- **PDP** sticks carry **API10** in `Unique ID` → join to `engineering_db.curated.wells`
  (api10-keyed, already has wellstick geometry + Enverus/Novi-bulk attrs) and `curated.production`
  for actual monthly history. **(VERIFY)** whether PDP wells *also* appear in the Novi forecast
  file under a name; if not, PDP production plots (Phase 4) come from engineering_db actuals.
- `pad_name` in the streams = the pad string; reliable for PUD/RES, placeholder for PDP.

---

## 5. EUR & stitch recipe

- **EUR is already on each stick** (`Oil_EUR`/`Gas_EUR`/`NGL_EUR`/`Water_EUR`); the valuation does
  **not** need to recompute it. Treat on-stick EUR as authoritative for value; **(VERIFY)** it
  equals the 50-yr integral of (forecast + Arps tail).
- **Production profile for plots:** the Forecast stream already gives ~29.5 yr monthly. The Arps
  params extend the tail to day 18250 (50 yr). Recipe: **plot the Forecast stream as-is; if a
  50-yr profile is wanted, append the final Arps exponential segment from the stream's last
  `ip_day` to 18250.** No fitting; minimal stitching (contrary to the original plan's emphasis).
- Normalization: `Norm_DC`/`Norm_DCET` are per-ft; EURs appear **absolute** (not per-ft). Per-ft
  normalization for display uses `LL_ft`. **(VERIFY)** EURs are not pre-normalized.

---

## 6. Open items

Resolved during the Workstream A load (verified against real data):
- ✅ **IRR units** — normalized to **percent** in `curated.intel_locations` (self-calibrating
  per-slice rule; see §2). Post-normalization slice medians 32–79%, no double-scaling.
- ✅ **PDP↔stream join** — PDP is **not** in the Novi forecast (Midland forecast = exactly its
  PUD+RES; 0 unmatched). PDP production comes from `curated.production` by api10 (PDP→`curated.wells`
  match = 99.9%). Delaware forecast has 1,865 extra inventory names (no stick/geometry; harmless).
- ✅ **Forecast horizon** — uniform: ip_day 30→10,770 (~29.5 yr, 30-day steps) across both basins;
  a sample well returns 359 monthly points.
- ✅ **Arps streams / water** — oil/gas/water all present, exactly **3 segments** per well-stream,
  final `day_stop=18250` (50 yr).
- ✅ **PUD/RES → analytics + arps + forecast** — **100%** coverage, all slices.
- ✅ **`Has Econom='No'`** — negligible (48 Delaware, 9 Midland); keep for now, filterable.

Still open (await the Novi Intelligence data dictionary shipping with the API):
- **Exact definitions** of `PV` vs `NPV`, the `*_B_e` breakeven variants, and `TTPT`.
- **Stream/EUR units** (assumed bopd/mcfd/bwpd; bbl/mcf) — confirm against the dictionary.
- Whether on-stick `Oil_EUR` equals the 50-yr integral of (forecast + Arps tail).

---

## 7. engineering_db mapping — **BUILT** (Workstream A complete, 3Q25)

Implemented in `engineering_db` (`sql/11_raw_novi_intel.sql`, `sql/12_curated_intel.sql`,
`etl/novi_intel/`, `scripts/load_novi_intel.py`):

- **`raw_novi_intel`** — `sticks` (248,618; geometry + economics), `pads`, `analytics` (205,751),
  `arps` (1,851,759), `forecast` (**73,864,609**), `land_grid`, `basin_outline`. All EPSG:4326,
  tagged `basin` + `report_version='3Q25'`.
- **`curated.intel_locations`** (MATERIALIZED, 248,618) — normalized sticks: `irr_pct` in percent,
  pad NPV rollup, `api10` + `pdp_in_warehouse` crosswalk to `curated.wells`, gunbarrel points
  (PUD/RES), GIST-indexed `wellstick_geom`. Unique key `stick_id` (CONCURRENTLY-refreshable).
- **`curated.intel_arps`**, **`curated.intel_forecast`** — thin views (forecast not materialized;
  app filters by `novi_wellname` against raw btree index). Wired into `curated.refresh_all()`.

Discovery/verification scripts live in `erebor/docs/discovery/`. Snowflake-API cutover (~July 2026)
replaces only `etl/novi_intel/` — these tables/views and the app stay unchanged.
