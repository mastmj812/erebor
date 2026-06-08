"""Phase 0: characterize the forecast stream cadence/horizon (read only the first well's
contiguous block — file is sorted by well then ip_day) and sample well-name styles to
assess the PDP (API-keyed) join gap. Never loads the whole multi-GB file."""
import csv, glob, os

ROOTS = {
    "delaware": r"C:\Users\MichaelMast\Blue Ox Resources\Engineering - General\Novi Intelligence\Delaware\3Q25",
    "midland":  r"C:\Users\MichaelMast\Blue Ox Resources\Engineering - General\Novi Intelligence\Midland\3Q25",
}


def first_forecast(root):
    for p in glob.glob(os.path.join(root, "**", "*.csv"), recursive=True):
        if "forecast" in os.path.basename(p).lower():
            return p
    return None


def looks_numeric(s):
    return s.replace(".", "", 1).isdigit()


def probe(path, label):
    print(f"\n=== {label}: {os.path.basename(path)} ===")
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as fh:
        rdr = csv.DictReader(fh)
        first_well = None
        ipdays = []
        names_seen = []
        numeric_name_hits = 0
        rows_scanned = 0
        for row in rdr:
            rows_scanned += 1
            wn = row["novi_wellname"]
            if first_well is None:
                first_well = wn
            if wn == first_well:
                ipdays.append(int(float(row["ip_day"])))
            # collect distinct names + numeric-name detection across first 200k rows
            if wn not in names_seen and len(names_seen) < 12:
                names_seen.append(wn)
            if looks_numeric(wn):
                numeric_name_hits += 1
            if rows_scanned >= 200000:
                break
        steps = sorted(set(ipdays))
        diffs = sorted(set(steps[i+1]-steps[i] for i in range(len(steps)-1))) if len(steps) > 1 else []
        print(f"  first well: {first_well!r}")
        print(f"  ip_day for first well: count={len(ipdays)} min={min(ipdays)} max={max(ipdays)} "
              f"(~{max(ipdays)/365:.1f} yr); step set={diffs[:5]}")
        print(f"  rows scanned: {rows_scanned}; numeric (API-style) novi_wellname hits: {numeric_name_hits}")
        print(f"  sample distinct names: {names_seen}")


if __name__ == "__main__":
    for basin, root in ROOTS.items():
        fp = first_forecast(root)
        if fp:
            probe(fp, basin.upper())
