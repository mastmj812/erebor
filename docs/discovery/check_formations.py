"""Distinct Novi Intelligence formation strings + counts (to extend the palette)."""
import os, sys
os.chdir(r"C:\Users\MichaelMast\Projects\engineering_db")
sys.path.insert(0, r"C:\Users\MichaelMast\Projects\engineering_db")
from etl.db import get_connection
with get_connection() as conn, conn.cursor() as cur:
    cur.execute("select formation, count(*) from curated.intel_locations group by 1 order by 2 desc")
    rows = cur.fetchall()
    print(f"{len(rows)} distinct formations:")
    for f, n in rows:
        print(f"   {n:>7}  {f!r}")
