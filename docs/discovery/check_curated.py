"""Verify curated.intel_* (run with engineering_db venv)."""
import os, sys
os.chdir(r"C:\Users\MichaelMast\Projects\engineering_db")
sys.path.insert(0, r"C:\Users\MichaelMast\Projects\engineering_db")
from etl.db import get_connection

Q = {
 "intel_locations rows by basin/category":
   "select basin, category, count(*) from curated.intel_locations group by 1,2 order by 1,2",
 "irr_pct AFTER normalization (median per slice; all should be percent-scale)":
   "select basin, category, "
   "round((percentile_cont(0.5) within group (order by irr_pct))::numeric,1) p50_pct, "
   "round(min(irr_pct)::numeric,1) mn, round(max(irr_pct)::numeric,1) mx "
   "from curated.intel_locations where irr_pct is not null group by 1,2 order by 1,2",
 "pad_npv25 coverage by category":
   "select category, count(*) total, count(pad_npv25) with_pad_npv from curated.intel_locations group by 1 order by 1",
 "gunbarrel point coverage (heel_lat) by category":
   "select category, count(*) total, count(heel_lat) with_points from curated.intel_locations group by 1 order by 1",
 "PDP -> warehouse match flag":
   "select count(*) pdp, count(*) filter (where pdp_in_warehouse) matched "
   "from curated.intel_locations where category='PDP'",
 "intel_arps view rowcount":
   "select count(*) from curated.intel_arps",
 "intel_forecast view — one well's profile length + max mop":
   "select count(*) pts, max(mop) max_mop from curated.intel_forecast where novi_wellname='Andrews copy 142 WCB 1'",
 "AOI spatial test — ST_Intersects bbox near Eddy Co (Delaware), by category":
   "select category, count(*) from curated.intel_locations "
   "where basin='delaware' and ST_Intersects(wellstick_geom, ST_MakeEnvelope(-104.25,31.95,-104.10,32.05,4326)) "
   "group by 1 order by 1",
}
with get_connection() as conn, conn.cursor() as cur:
    for label, q in Q.items():
        cur.execute(q)
        print(f"\n# {label}")
        for r in cur.fetchall():
            print("   ", r)
