#!/usr/bin/env python3
"""
Build the district (Kreis) dataset for the relocation dashboard.

Run from the repo root with:   python3 -I scripts/build_data.py

Inputs (in data/raw/, downloaded by scripts/fetch_sources.sh):
  - counties.geojson     BKG VG250 district boundaries (AGS, GEN, BEZ, SN_L, ...)
  - btw25_kerg2.csv      Bundestagswahl 2025 results (Bundeswahlleiterin, by state/Wahlkreis)
  - scripts/intl_schools.csv   curated international / English-medium schools

Outputs (committed, served by GitHub Pages):
  - data/kreise.json     one record per district with metrics + distances
  - data/kreise.geojson  simplified boundaries for the choropleth map

Socio-economic indicators that need the free GENESIS token (foreign share,
land use, crime, housing cost) are left as null here and documented in README.
They are editable in the dashboard and can be filled by fetch_genesis.py later.
"""
import csv, json, math, sys, urllib.request, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data"

# --- Distance anchors (public SAP campus / city coords; approximate) ----------
ANCHORS = {
    "work_rot":   {"label": "SAP St. Leon-Rot (ROT)", "lat": 49.2647, "lon": 8.6180},
    "work_wdf":   {"label": "SAP Walldorf (WDF)",      "lat": 49.2936, "lon": 8.6428},
    "heidelberg": {"label": "Heidelberg",              "lat": 49.3988, "lon": 8.6724},
}

STATE = {
    "01": "Schleswig-Holstein", "02": "Hamburg", "03": "Niedersachsen",
    "04": "Bremen", "05": "Nordrhein-Westfalen", "06": "Hessen",
    "07": "Rheinland-Pfalz", "08": "Baden-Württemberg", "09": "Bayern",
    "10": "Saarland", "11": "Berlin", "12": "Brandenburg",
    "13": "Mecklenburg-Vorpommern", "14": "Sachsen", "15": "Sachsen-Anhalt",
    "16": "Thüringen",
}

# Parties we surface for the political-fit criterion (kerg2 Gruppenname -> label)
PARTIES = ["CDU", "CSU", "SPD", "GRÜNE", "AfD", "DIE LINKE", "FDP", "BSW", "FREIE WÄHLER"]

EARTH_KM = 6371.0088


def haversine(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (0.5 - math.cos((lat2 - lat1) * p) / 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2)
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


def de_float(s):
    """Parse a German-formatted number ('22,62437') -> float, else None."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s.replace(".", "").replace(",", "."))
    except ValueError:
        return None


def rings(geom):
    """Yield exterior rings (lists of [lon,lat]) for Polygon / MultiPolygon."""
    t = geom["type"]
    if t == "Polygon":
        yield geom["coordinates"][0]
    elif t == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield poly[0]


def ring_centroid_area(ring):
    """Planar centroid + area (km^2) of a lon/lat ring via equirectangular proj."""
    if len(ring) < 4:
        lat = sum(p[1] for p in ring) / len(ring)
        lon = sum(p[0] for p in ring) / len(ring)
        return lat, lon, 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(lat0 * math.pi / 180)
    xs = [p[0] * k * 111.320 for p in ring]   # km east
    ys = [p[1] * 110.574 for p in ring]        # km north
    A = cx = cy = 0.0
    for i in range(len(ring) - 1):
        cross = xs[i] * ys[i + 1] - xs[i + 1] * ys[i]
        A += cross
        cx += (xs[i] + xs[i + 1]) * cross
        cy += (ys[i] + ys[i + 1]) * cross
    if A == 0:
        lat = sum(p[1] for p in ring) / len(ring)
        lon = sum(p[0] for p in ring) / len(ring)
        return lat, lon, 0.0
    cx /= (3 * A)
    cy /= (3 * A)
    lon = cx / (k * 111.320)
    lat = cy / 110.574
    return lat, lon, abs(A) / 2.0


def district_centroid_area(geom):
    """Largest-ring centroid; summed area across all exterior rings (km^2)."""
    best = None
    area = 0.0
    for ring in rings(geom):
        la, lo, ar = ring_centroid_area(ring)
        area += ar
        if best is None or ar > best[2]:
            best = (la, lo, ar)
    return best[0], best[1], area


def load_political():
    """Return {state_code: {party: zweitstimmen_pct}} from kerg2 (Stimme==2)."""
    path = RAW / "btw25_kerg2.csv"
    if not path.exists():
        print("  ! election file missing; political data skipped", file=sys.stderr)
        return {}
    rows = list(csv.reader(open(path, encoding="utf-8-sig"), delimiter=";"))
    hdr = rows[9]
    idx = {h: j for j, h in enumerate(hdr)}
    out = {}
    for r in rows[10:]:
        if len(r) <= idx["Prozent"]:
            continue
        if r[idx["Gebietsart"]] != "Land":
            continue
        if r[idx["Gruppenart"]] != "Partei" or r[idx["Stimme"]] != "2":
            continue
        code = r[idx["Gebietsnummer"]].zfill(2)
        party = r[idx["Gruppenname"]].strip()
        if party not in PARTIES:
            continue
        pct = de_float(r[idx["Prozent"]])
        if pct is not None:
            out.setdefault(code, {})[party] = round(pct, 2)
    return out


def load_schools():
    path = ROOT / "scripts" / "intl_schools.csv"
    out = []
    for row in csv.DictReader(open(path, encoding="utf-8")):
        out.append((row["name"], row["city"], float(row["lat"]), float(row["lon"])))
    return out


def wikidata_population():
    """Best-effort {ags5: population} via Wikidata SPARQL (P440 district key)."""
    q = ("SELECT ?ags (SAMPLE(?p) AS ?pop) WHERE {"
         "?i wdt:P440 ?ags. OPTIONAL{?i wdt:P1082 ?p.} } GROUP BY ?ags")
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode(
        {"query": q, "format": "json"})
    req = urllib.request.Request(url, headers={
        "User-Agent": "relocation-dashboard/1.0 (personal house-search project)",
        "Accept": "application/sparql-results+json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
    except Exception as e:  # noqa: BLE001 - best effort, never fatal
        print(f"  ! Wikidata population fetch failed ({e}); population=null", file=sys.stderr)
        return {}
    out = {}
    for b in data["results"]["bindings"]:
        ags = b["ags"]["value"].strip()
        if "pop" in b:
            try:
                out[ags] = int(float(b["pop"]["value"]))
            except ValueError:
                pass
    print(f"  Wikidata: population for {len(out)} districts")
    return out


def simplify_ring(ring, nd=3):
    """Round coords and drop consecutive duplicates to shrink the geojson."""
    out = []
    for lon, lat in ring:
        pt = [round(lon, nd), round(lat, nd)]
        if not out or out[-1] != pt:
            out.append(pt)
    return out if len(out) >= 4 else ring


def simplify_geom(geom, nd=3):
    t = geom["type"]
    if t == "Polygon":
        return {"type": t, "coordinates": [simplify_ring(geom["coordinates"][0], nd)]}
    if t == "MultiPolygon":
        return {"type": t,
                "coordinates": [[simplify_ring(p[0], nd)] for p in geom["coordinates"]]}
    return geom


def main():
    print("Loading boundaries...")
    gj = json.load(open(RAW / "counties.geojson", encoding="utf-8"))
    political = load_political()
    schools = load_schools()
    pop = wikidata_population()
    print(f"  political: {len(political)} states, schools: {len(schools)}")

    records, out_features = [], []
    for ft in gj["features"]:
        p = ft["properties"]
        ags = p["AGS"]
        code = p.get("SN_L", ags[:2])
        lat, lon, area = district_centroid_area(ft["geometry"])
        dist = {k: round(haversine(lat, lon, a["lat"], a["lon"]), 1)
                for k, a in ANCHORS.items()}
        nearest = min(
            (round(haversine(lat, lon, s[2], s[3]), 1), s[0], s[1]) for s in schools)
        population = pop.get(ags)
        density = round(population / area, 1) if population and area else None

        records.append({
            "ags": ags,
            "name": p.get("GEN"),
            "type": p.get("BEZ"),
            "state": STATE.get(code, "?"),
            "lat": round(lat, 4), "lon": round(lon, 4),
            "area_km2": round(area, 1),
            "metrics": {
                "population": population,
                "density": density,
                "dist_work_rot": dist["work_rot"],
                "dist_work_wdf": dist["work_wdf"],
                "dist_heidelberg": dist["heidelberg"],
                "intl_school_km": nearest[0],
                "intl_school_name": f"{nearest[1]} ({nearest[2]})",
                "politics": political.get(code, {}),
                # --- needs GENESIS token; editable in UI, filled by fetch_genesis.py ---
                "foreign_share": None,
                "green_share": None,
                "crime_per100k": None,
                "landprice_eur_m2": None,
            },
        })
        sg = simplify_geom(ft["geometry"])
        out_features.append({"type": "Feature", "id": ags,
                             "properties": {"ags": ags, "name": p.get("GEN")},
                             "geometry": sg})

    records.sort(key=lambda r: (r["ags"]))
    meta = {
        "generated_from": "BKG VG250, Bundeswahlleiterin BTW2025, Wikidata, curated schools",
        "anchors": ANCHORS,
        "district_count": len(records),
        "note": "foreign_share/green_share/crime_per100k/landprice_eur_m2 need GENESIS token (see README).",
    }
    json.dump({"meta": meta, "districts": records},
              open(OUT / "kreise.json", "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    json.dump({"type": "FeatureCollection", "features": out_features},
              open(OUT / "kreise.geojson", "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))

    with_pol = sum(1 for r in records if r["metrics"]["politics"])
    with_pop = sum(1 for r in records if r["metrics"]["population"])
    print(f"\nWrote {len(records)} districts:")
    print(f"  kreise.json    {(OUT/'kreise.json').stat().st_size//1024} KB")
    print(f"  kreise.geojson {(OUT/'kreise.geojson').stat().st_size//1024} KB")
    print(f"  political populated: {with_pol}/{len(records)}")
    print(f"  population populated: {with_pop}/{len(records)}")


if __name__ == "__main__":
    main()
