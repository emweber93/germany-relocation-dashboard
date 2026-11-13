#!/usr/bin/env python3
"""
Enrich data/kreise.json with district-level indicators from downloaded sources,
then (separately) rebuild towns with build_towns.py so towns inherit them.

Sources handled (each optional — only applied if the file is present):
  - data/raw/bka_kreise_hz.xlsx   BKA PKS: total-crime frequency (HZ /100k) -> crime_per100k
  - data/raw/foreign_share.csv    ags;share  -> foreign_share   (if present)
  - data/raw/landprice.csv        ags;eur_m2 -> landprice_eur_m2 (if present)

Run:  python3 -I scripts/enrich_kreise.py
"""
import csv, json, re, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
KJSON = ROOT / "data" / "kreise.json"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def read_xlsx(path):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{NS}si"):
            ss.append("".join(e.text or "" for e in si.iter(f"{NS}t")))

    def colnum(ref):
        c = re.match(r"[A-Z]+", ref).group(); n = 0
        for ch in c:
            n = n * 26 + (ord(ch) - 64)
        return n

    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    for row in sheet.find(f"{NS}sheetData").findall(f"{NS}row"):
        cells = {}
        for c in row.findall(f"{NS}c"):
            v = c.find(f"{NS}v"); val = "" if v is None else v.text
            if c.get("t") == "s" and val not in (None, ""):
                val = ss[int(val)]
            cells[colnum(c.get("r"))] = val
        yield cells


def crime_from_bka():
    path = RAW / "bka_kreise_hz.xlsx"
    if not path.exists():
        return {}
    out = {}
    for cells in read_xlsx(path):
        if cells.get(1) == "------":            # Schlüssel = Straftaten insgesamt
            ags = (cells.get(3) or "").strip().zfill(5)
            hz = cells.get(7)
            if ags.isdigit() and hz:
                try:
                    out[ags] = round(float(hz))
                except ValueError:
                    pass
    return out


def simple_csv(path, scale=1.0):
    """Read 'ags;value' CSV. Values are plain floats ('21.3' or '21,3')."""
    if not path.exists():
        return {}
    out = {}
    for row in csv.reader(open(path, encoding="utf-8-sig"), delimiter=";"):
        if len(row) < 2:
            continue
        ags = row[0].strip().zfill(5)
        val = row[1].strip().replace(",", ".")
        if ags.isdigit() and val:
            try:
                out[ags] = round(float(val) * scale, 2)
            except ValueError:
                pass
    return out


def main():
    data = json.load(open(KJSON, encoding="utf-8"))
    by = {d["ags"]: d for d in data["districts"]}
    sources = {
        "crime_per100k": crime_from_bka(),
        "foreign_share": simple_csv(RAW / "foreign_share.csv"),
        "landprice_eur_m2": simple_csv(RAW / "landprice.csv"),
    }
    for key, vals in sources.items():
        hit = 0
        for ags, v in vals.items():
            if ags in by:
                by[ags]["metrics"][key] = v; hit += 1
        print(f"  {key}: {hit}/{len(by)} districts set" + (" (no source file)" if not vals else ""))
    json.dump(data, open(KJSON, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("Updated data/kreise.json — now run:  python3 -I scripts/build_towns.py")


if __name__ == "__main__":
    main()
