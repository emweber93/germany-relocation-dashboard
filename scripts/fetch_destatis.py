#!/usr/bin/env python3
"""
Fetch district-level indicators from destatis GENESIS (www-genesis.destatis.de)
and write plain CSVs into data/raw/ for enrich_kreise.py to merge.

Produces:
  data/raw/foreign_share.csv   ags;percent   (foreign residents ÷ population)
  data/raw/population.csv       ags;count

Auth: destatis GENESIS REST 2020 wants credentials in the HTTP HEADER plus a
form-urlencoded body, method POST (NOT body params — that logs in as guest).
A free account is required (https://www-genesis.destatis.de → Registrierung);
use an ALPHANUMERIC password (symbols like § break header auth).

Run:
  export GENESIS_USER="your-kennung-or-email"
  export GENESIS_PASS="your-password"
  python3 -I scripts/fetch_destatis.py

Notes:
  - Crime (Safety) is NOT in GENESIS — it comes from the BKA xlsx (see enrich_kreise.py).
  - Land price (Cost) exists only at Bundesland level here (table 61511), too coarse
    to distinguish towns in the same state, so it is intentionally left editable.
"""
import csv, io, os, sys, urllib.parse, urllib.request, zipfile

BASE = "https://www-genesis.destatis.de/genesisWS/rest/2020"


def fetch_flat(name, startyear="2023"):
    u, p = os.environ.get("GENESIS_USER"), os.environ.get("GENESIS_PASS")
    if not (u and p):
        sys.exit("Set GENESIS_USER and GENESIS_PASS (see header).")
    body = urllib.parse.urlencode({"name": name, "area": "all", "format": "ffcsv",
                                   "compress": "false", "language": "de", "startyear": startyear}).encode()
    req = urllib.request.Request(f"{BASE}/data/tablefile", data=body, method="POST",
                                 headers={"username": u, "password": p,
                                          "Content-Type": "application/x-www-form-urlencoded"})
    raw = urllib.request.urlopen(req, timeout=120).read()
    if raw[:2] == b"PK":                       # zipped flat CSV
        z = zipfile.ZipFile(io.BytesIO(raw))
        raw = z.read(z.namelist()[0])
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig", "replace")), delimiter=";"))


def latest_by_ags(rows, sex_total=False):
    best = {}
    for r in rows:
        if sex_total and r.get("2_variable_attribute_label") != "Insgesamt":
            continue
        ags = (r.get("1_variable_attribute_code") or "").strip()
        if not (ags.isdigit() and len(ags) == 5):
            continue
        t = r.get("time", ""); v = (r.get("value") or "").strip().replace(",", ".")
        try:
            val = float(v)
        except ValueError:
            continue
        if ags not in best or t > best[ags][0]:
            best[ags] = (t, val)
    return {a: v for a, (t, v) in best.items()}


def main():
    foreign = latest_by_ags(fetch_flat("12521-0040"), sex_total=True)   # Ausländer: Kreise
    population = latest_by_ags(fetch_flat("12411-0015"))                # Bevölkerung: Kreise
    common = sorted(set(foreign) & set(population))
    raw = __import__("pathlib").Path(__file__).resolve().parent.parent / "data" / "raw"
    with open(raw / "foreign_share.csv", "w") as f:
        for a in common:
            f.write(f"{a};{round(foreign[a] / population[a] * 100, 1)}\n")
    with open(raw / "population.csv", "w") as f:
        for a in common:
            f.write(f"{a};{int(population[a])}\n")
    print(f"Wrote foreign_share.csv + population.csv for {len(common)} districts.")
    print("Now run:  python3 -I scripts/enrich_kreise.py && python3 -I scripts/build_towns.py")


if __name__ == "__main__":
    main()
