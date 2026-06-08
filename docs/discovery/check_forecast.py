"""Verify the forecast load + its coverage vs sticks/analytics. Run with engineering_db venv."""
import os, sys
os.chdir(r"C:\Users\MichaelMast\Projects\engineering_db")
sys.path.insert(0, r"C:\Users\MichaelMast\Projects\engineering_db")
from etl.db import get_connection

Q = {
 "forecast rows / distinct wells / ip_day range":
   "select basin, count(*) rows, count(distinct novi_wellname) wells, "
   "min(ip_day) mn, max(ip_day) mx from raw_novi_intel.forecast group by 1",
 "PUD/RES sticks -> forecast coverage":
   "select s.basin, s.category, count(*) sticks, count(f.novi_wellname) matched, "
   "round(100.0*count(f.novi_wellname)/count(*),1) pct "
   "from raw_novi_intel.sticks s "
   "left join (select distinct basin, novi_wellname from raw_novi_intel.forecast) f "
   "  on f.basin=s.basin and f.novi_wellname=s.unique_id "
   "where s.category in ('PUD','RES') group by 1,2 order by 1,2",
 "forecast wells NOT matching any PUD/RES stick (PDP/other?)":
   "select f.basin, count(*) unmatched_wells from "
   "(select distinct basin, novi_wellname from raw_novi_intel.forecast) f "
   "left join (select distinct basin, unique_id from raw_novi_intel.sticks where category in ('PUD','RES')) s "
   "  on s.basin=f.basin and s.unique_id=f.novi_wellname "
   "where s.unique_id is null group by 1",
 "sample unmatched forecast names":
   "select f.basin, f.novi_wellname from "
   "(select distinct basin, novi_wellname from raw_novi_intel.forecast) f "
   "left join (select distinct basin, unique_id from raw_novi_intel.sticks where category in ('PUD','RES')) s "
   "  on s.basin=f.basin and s.unique_id=f.novi_wellname "
   "where s.unique_id is null limit 6",
}
with get_connection() as conn, conn.cursor() as cur:
    for label, q in Q.items():
        cur.execute(q)
        print(f"\n# {label}")
        for r in cur.fetchall():
            print("   ", r)
