"""Connectivity + readiness check against engineering_db. Run with the engineering_db venv:
  <engineering_db>\.venv\Scripts\python.exe erebor\docs\discovery\check_db.py
Chdirs into engineering_db so its .env is picked up by load_dotenv()."""
import os, sys
os.chdir(r"C:\Users\MichaelMast\Projects\engineering_db")
sys.path.insert(0, r"C:\Users\MichaelMast\Projects\engineering_db")
from dotenv import load_dotenv
load_dotenv()

pw = os.getenv("DB_PASSWORD", "")
print(f"env: DB_HOST={os.getenv('DB_HOST')!r} DB_NAME={os.getenv('DB_NAME')!r} "
      f"DB_USER={os.getenv('DB_USER')!r} DB_PASSWORD set={bool(pw)} (len={len(pw)})")

# Use engineering_db's own canonical connection helper (same path the nightly ETL uses).
from etl.db import get_connection
c = get_connection()
cur = c.cursor()

cur.execute("select postgis_lib_version()")
print("postgis:", cur.fetchone()[0])

cur.execute("select nspname from pg_namespace where nspname like 'raw_%' or nspname in ('curated','meta') order by 1")
print("schemas:", [r[0] for r in cur.fetchall()])

cur.execute("select count(*), count(distinct api10) from curated.wells")
print("curated.wells rows / distinct api10:", cur.fetchone())

# Do the sample PDP Unique IDs (API10) from the Novi Intelligence sticks resolve in curated.wells?
sample = ("3001534505", "3001535597", "4200343191", "4200343274")
cur.execute("select count(*) from curated.wells where api10 = any(%s)", (list(sample),))
print(f"sample PDP api10 present in curated.wells (of {len(sample)}):", cur.fetchone()[0])

# does raw_novi_intel already exist?
cur.execute("select exists(select 1 from pg_namespace where nspname='raw_novi_intel')")
print("raw_novi_intel schema exists:", cur.fetchone()[0])

c.close()
