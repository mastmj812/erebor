"""Validate the /api/export zip in-memory (no file locks). Small AOI for speed."""
import io, json, urllib.request, zipfile

aoi = {"type": "Polygon", "coordinates": [[
    [-104.20, 31.98], [-104.16, 31.98], [-104.16, 32.02], [-104.20, 32.02], [-104.20, 31.98]
]]}
body = json.dumps({
    "aoi": aoi, "basin": "delaware", "rule": "intersects",
    "exclude_wells": [], "exclude_formations": [],
}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:8077/api/export", data=body,
    headers={"Content-Type": "application/json"},
)
data = urllib.request.urlopen(req, timeout=180).read()
print(f"zip bytes: {len(data)}")
z = zipfile.ZipFile(io.BytesIO(data))
for i in z.infolist():
    print(f"  {i.filename}: {i.file_size} B")
loc = z.read("locations.csv").decode().splitlines()
print("locations data rows:", len(loc) - 1)
print("locations header:", loc[0][:220])
prod = z.read("production_monthly.csv").decode().splitlines()
arps = z.read("arps.csv").decode().splitlines()
print("production rows:", len(prod) - 1, "| arps rows:", len(arps) - 1)
print("--- summary.csv ---")
for line in z.read("summary.csv").decode().splitlines():
    print("  ", line)
