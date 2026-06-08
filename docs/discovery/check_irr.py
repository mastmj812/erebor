"""Diagnose irr_pct units per basin/category to design a normalization rule."""
import os, sys
os.chdir(r"C:\Users\MichaelMast\Projects\engineering_db")
sys.path.insert(0, r"C:\Users\MichaelMast\Projects\engineering_db")
from etl.db import get_connection

q = """
select basin, category,
       count(*)                                   n,
       round(min(irr_pct)::numeric,3)             mn,
       round(max(irr_pct)::numeric,2)             mx,
       round(avg(irr_pct)::numeric,3)             avg,
       round((percentile_cont(0.5) within group (order by irr_pct))::numeric,3) p50,
       sum((irr_pct >  5)::int)                    gt5,
       sum((irr_pct between 0 and 5)::int)         in_0_5,
       sum((irr_pct < 0)::int)                     neg
from raw_novi_intel.sticks
where irr_pct is not null
group by 1,2 order by 1,2
"""
with get_connection() as conn, conn.cursor() as cur:
    cur.execute(q)
    print("basin     cat   n      min     max      avg     p50    >5     0..5    <0")
    for r in cur.fetchall():
        print(f"{r[0]:<9} {r[1]:<4} {r[2]:>6} {str(r[3]):>7} {str(r[4]):>8} {str(r[5]):>7} {str(r[6]):>6} {r[7]:>6} {r[8]:>7} {r[9]:>5}")
