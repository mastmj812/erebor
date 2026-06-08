"""Verify the raw_novi_intel shapefile load (run with engineering_db venv)."""
import os, sys
os.chdir(r"C:\Users\MichaelMast\Projects\engineering_db")
sys.path.insert(0, r"C:\Users\MichaelMast\Projects\engineering_db")
from etl.db import get_connection

Q = {
 "sticks by basin/category (rows / geom / api10)":
   "select basin, category, count(*), count(geom), count(api10) "
   "from raw_novi_intel.sticks group by 1,2 order by 1,2",
 "stick geometry types":
   "select GeometryType(geom), count(*) from raw_novi_intel.sticks group by 1",
 "stick SRIDs":
   "select distinct ST_SRID(geom) from raw_novi_intel.sticks",
 "invalid stick geoms":
   "select count(*) from raw_novi_intel.sticks where geom is not null and not ST_IsValid(geom)",
 "has_econ distribution":
   "select basin, has_econ, count(*) from raw_novi_intel.sticks group by 1,2 order by 1,2",
 "economics non-null (npv25 / oil_eur)":
   "select count(*) total, count(npv25) has_npv25, count(oil_eur) has_oileur from raw_novi_intel.sticks",
 "PDP api10 -> curated.wells linkage":
   "select s.basin, count(*) pdp_total, count(w.api10) matched, "
   "round(100.0*count(w.api10)/count(*),1) pct "
   "from raw_novi_intel.sticks s left join curated.wells w on w.api10=s.api10 "
   "where s.category='PDP' group by 1 order by 1",
 "pads / grid / outline counts":
   "select 'pads' t, basin, count(*), count(geom) from raw_novi_intel.pads group by 2 "
   "union all select 'land_grid', basin, count(*), count(geom) from raw_novi_intel.land_grid group by 2 "
   "union all select 'basin_outline', basin, count(*), count(geom) from raw_novi_intel.basin_outline group by 2 "
   "order by 1,2",
 "sample PUD/RES unique_id values":
   "select category, unique_id from raw_novi_intel.sticks where category in ('PUD','RES') limit 4",
}

with get_connection() as conn, conn.cursor() as cur:
    for label, q in Q.items():
        cur.execute(q)
        rows = cur.fetchall()
        print(f"\n# {label}")
        for r in rows:
            print("   ", r)
