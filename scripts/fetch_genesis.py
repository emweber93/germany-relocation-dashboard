#!/usr/bin/env python3
"""
OPTIONAL enrichment — fill the four GENESIS-gated metrics into data/kreise.json:
    foreign_share, green_share, crime_per100k*, landprice_eur_m2

*crime comes from BKA PKS, not GENESIS — see note below.

=============================================================================
STATUS: TEMPLATE — NOT verified end-to-end (writing this needs a free
regionalstatistik.de account, which is yours to create). The REST pattern below
is correct; the TABLE CODES and the column you extract almost certainly need a
one-time tweak on first run. Run it, inspect the printed columns, adjust MAPPING,
re-run. Ask Claude to finish+test this once you have a token.
=============================================================================

Setup:
  1. Free account: https://www.regionalstatistik.de  (Anmelden → Registrieren)
  2. export GENESIS_USER="..."  GENESIS_PASS="..."
  3. python3 -I scripts/fetch_genesis.py

Docs: https://www.regionalstatistik.de/genesis/misc/GENESIS-Webservices_Einfuehrung.pdf
"""
import csv, io, json, os, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KJSON = ROOT / "data" / "kreise.json"
BASE = "https://www.regionalstatistik.de/genesisws/rest/2020/data/tablefile"

# metric_key -> (GENESIS table code, hint for which value column to read).
# VERIFY these codes in the GENESIS table finder; they are the usual suspects.
MAPPING = {
    "foreign_share":    ("12521-01-04", "Ausländeranteil / compute foreigners ÷ population × 100"),
    "green_share":      ("33111-01-01-4", "sum Landwirtschaft+Wald+Wasser ÷ total area × 100"),
    "landprice_eur_m2": ("61511-01-03", "Kaufwerte für baureifes Land, EUR/m²"),
    # crime is NOT GENESIS: download BKA PKS 'Kreise' Excel and map Häufigkeitszahl -> crime_per100k.
}


def fetch_table(code):
    user, pw = os.environ.get("GENESIS_USER"), os.environ.get("GENESIS_PASS")
    if not (user and pw):
        sys.exit("Set GENESIS_USER and GENESIS_PASS first (see header).")
    q = urllib.parse.urlencode({
        "username": user, "password": pw, "name": code,
        "area": "all", "format": "ffcsv", "compress": "false", "language": "de"})
    with urllib.request.urlopen(f"{BASE}?{q}", timeout=120) as r:
        return r.read().decode("utf-8-sig")


def main():
    data = json.load(open(KJSON, encoding="utf-8"))
    by_ags = {d["ags"]: d for d in data["districts"]}
    for key, (code, hint) in MAPPING.items():
        print(f"\n=== {key}  (table {code}) — {hint}")
        try:
            raw = fetch_table(code)
        except Exception as e:  # noqa: BLE001
            print(f"  fetch failed: {e}"); continue
        rows = list(csv.reader(io.StringIO(raw), delimiter=";"))
        print("  columns:", rows[0] if rows else "(empty)")
        print("  >> inspect the columns above, then map the 5-digit AGS + value into by_ags[ags]['metrics']['%s']." % key)
        # Intentionally not auto-writing: the value column differs per table.
        # Once you know the indices, uncomment and adapt:
        # for r in rows[1:]:
        #     ags = r[AGS_COL].zfill(5)
        #     if ags in by_ags and r[VAL_COL]:
        #         by_ags[ags]["metrics"][key] = float(r[VAL_COL].replace(".","").replace(",","."))

    # json.dump(data, open(KJSON,"w",encoding="utf-8"), ensure_ascii=False, separators=(",",":"))
    print("\nWhen MAPPING is adapted, uncomment the write at the end to update data/kreise.json.")


if __name__ == "__main__":
    main()
