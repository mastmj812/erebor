"""Validate name-join coverage: PUD/RES sticks -> analytics / arps (forecast pending).
Run with engineering_db venv."""
import os, sys
os.chdir(r"C:\Users\MichaelMast\Projects\engineering_db")
sys.path.insert(0, r"C:\Users\MichaelMast\Projects\engineering_db")
from etl.db import get_connection

Q = {
 "analytics rows vs distinct well_name (dup check)":
   "select basin, count(*) rows, count(distinct well_name) distinct_names from raw_novi_intel.analytics group by 1",
 "PUD/RES sticks -> analytics coverage (by unique_id=well_name)":
   "select s.basin, s.category, count(*) sticks, count(a.well_name) matched, "
   "round(100.0*count(a.well_name)/count(*),1) pct "
   "from raw_novi_intel.sticks s "
   "left join (select distinct basin, well_name from raw_novi_intel.analytics) a "
   "  on a.basin=s.basin and a.well_name=s.unique_id "
   "where s.category in ('PUD','RES') group by 1,2 order by 1,2",
 "PUD/RES sticks -> arps coverage (by unique_id=novi_wellname)":
   "select s.basin, s.category, count(*) sticks, count(ar.novi_wellname) matched, "
   "round(100.0*count(ar.novi_wellname)/count(*),1) pct "
   "from raw_novi_intel.sticks s "
   "left join (select distinct basin, novi_wellname from raw_novi_intel.arps) ar "
   "  on ar.basin=s.basin and ar.novi_wellname=s.unique_id "
   "where s.category in ('PUD','RES') group by 1,2 order by 1,2",
 "arps streams present":
   "select production_stream, count(*) from raw_novi_intel.arps group by 1 order by 1",
 "arps segments per well/stream (sample distribution)":
   "select nseg, count(*) from (select novi_wellname, production_stream, count(*) nseg "
   "from raw_novi_intel.arps group by 1,2) t group by 1 order by 1 limit 10",
 "arps final-segment day_stop (50yr tail check)":
   "select max(day_stop) from raw_novi_intel.arps",
}
with get_connection() as conn, conn.cursor() as cur:
    for label, q in Q.items():
        cur.execute(q)
        print(f"\n# {label}")
        for r in cur.fetchall():
            print("   ", r)
