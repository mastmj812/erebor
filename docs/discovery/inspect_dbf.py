"""Phase 0 discovery: dump DBF attribute schema + sample rows from Novi Intelligence
shapefiles, without unzipping the whole archive. Read-only."""
import io, os, sys, tempfile, zipfile
from dbfread import DBF

BASINS = {
    "delaware": r"C:\Users\MichaelMast\Blue Ox Resources\Engineering - General\Novi Intelligence\Delaware\3Q25\shapefile-delaware-basin-report-q3-2025\Delaware Q3 2025 Basin Report Shapefile Download",
    "midland":  r"C:\Users\MichaelMast\Blue Ox Resources\Engineering - General\Novi Intelligence\Midland\3Q25\shapefile-midland-basin-report-q3-2025",
}
# label -> predicate on lowercased filename (startswith avoids matching Other_ML_*)
WANT = {
    "PDP_Oil":  lambda n: n.startswith("pdp_oil"),
    "PUD_Oil":  lambda n: n.startswith("pud_oil"),
    "Resource": lambda n: n.startswith("resource"),
    "Pad":      lambda n: "pad shapefile" in n or "pad)" in n,
}


def find_zip(folder, pred):
    for root, _, files in os.walk(folder):
        for f in files:
            if f.lower().endswith(".zip") and pred(f.lower()):
                return os.path.join(root, f)
    return None


def dump(zip_path, label):
    print(f"\n{'='*90}\n{label}\n  {zip_path}")
    if not zip_path or not os.path.exists(zip_path):
        print("  !! NOT FOUND")
        return
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        dbfs = [n for n in names if n.lower().endswith(".dbf")]
        if not dbfs:
            print("  !! no .dbf in archive; members:", names)
            return
        with tempfile.TemporaryDirectory() as td:
            # extract dbf + any memo sidecars sharing the stem
            stem = os.path.splitext(dbfs[0])[0]
            for n in names:
                if os.path.splitext(n)[0] == stem and n.lower().endswith((".dbf", ".dbt", ".fpt")):
                    z.extract(n, td)
            dbf_path = os.path.join(td, dbfs[0])
            t = DBF(dbf_path, load=False, encoding="latin-1", char_decode_errors="replace")
            print(f"  records: {len(t)}")
            print(f"  fields ({len(t.fields)}):")
            for fld in t.fields:
                print(f"    {fld.name:<24} {fld.type} len={fld.length} dec={fld.decimal_count}")
            print("  sample rows (first 3):")
            for i, rec in enumerate(t):
                if i >= 3:
                    break
                # print compactly
                items = {k: v for k, v in rec.items()}
                print(f"    [{i}] {items}")


if __name__ == "__main__":
    only = set(sys.argv[1:])  # optional: restrict to given labels
    for basin, folder in BASINS.items():
        for label, pred in WANT.items():
            if only and label not in only:
                continue
            zp = find_zip(folder, pred)
            dump(zp, f"{basin.upper()} :: {label}")
