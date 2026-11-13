#!/usr/bin/env python3
"""
Build the TOWN-level dataset (commuter belt ~50 km around the SAP offices),
assigning OSM amenities to towns by POINT-IN-POLYGON against real municipality
boundaries (not nearest-centroid, which badly misattributes city amenities to
small suburbs).

Run from repo root:   python3 -I scripts/build_towns.py
Depends on data/kreise.json (district inheritance) and:
  data/raw/towns_geom.json    OSM admin_level=8 relations WITH geometry (Overpass out geom)
  data/raw/amenities_raw.json OSM shops/amenities/parks in the region
Outputs (committed):  data/towns.json  +  data/towns.geojson
"""
import csv, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data"

ANCHORS = {
    "work_rot": {"label": "SAP St. Leon-Rot (ROT)", "lat": 49.2647, "lon": 8.6180},
    "work_wdf": {"label": "SAP Walldorf (WDF)", "lat": 49.2936, "lon": 8.6428},
    "heidelberg": {"label": "Heidelberg", "lat": 49.3988, "lon": 8.6724},
}
WORK_CENTER = (49.279, 8.630)
RADIUS_KM = 50

GROCERIES = {"supermarket", "convenience", "bakery", "butcher", "greengrocer"}
SCHOOLS = {"school", "kindergarten"}
HEALTH = {"doctors", "pharmacy", "hospital", "clinic"}
SOCIAL = {"restaurant", "cafe", "bar", "pub"}
EARTH_KM = 6371.0088


def hav(a, b, c, d):
    p = math.pi / 180
    x = (0.5 - math.cos((c - a) * p) / 2
         + math.cos(a * p) * math.cos(c * p) * (1 - math.cos((d - b) * p)) / 2)
    return 2 * EARTH_KM * math.asin(math.sqrt(x))


def elem_point(e):
    if "center" in e:
        return e["center"]["lat"], e["center"]["lon"]
    if "lat" in e:
        return e["lat"], e["lon"]
    return None


def stitch_rings(ways):
    """Join member ways (each a list of (lon,lat)) into closed rings."""
    segs = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == ring[-1]:
                    ring += s[-2::-1]; segs.pop(i); changed = True; break
                if s[-1] == ring[0]:
                    ring = s[:-1] + ring; segs.pop(i); changed = True; break
                if s[0] == ring[0]:
                    ring = s[1:][::-1] + ring; segs.pop(i); changed = True; break
        if len(ring) >= 4:
            rings.append(ring)
    return rings


def ring_centroid_area(ring):
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = math.cos(lat0 * math.pi / 180)
    xs = [p[0] * k * 111.320 for p in ring]
    ys = [p[1] * 110.574 for p in ring]
    A = cx = cy = 0.0
    for i in range(len(ring) - 1):
        cr = xs[i] * ys[i + 1] - xs[i + 1] * ys[i]
        A += cr; cx += (xs[i] + xs[i + 1]) * cr; cy += (ys[i] + ys[i + 1]) * cr
    if A == 0:
        return (sum(p[1] for p in ring) / len(ring), sum(p[0] for p in ring) / len(ring), 0.0)
    cx /= 3 * A; cy /= 3 * A
    return cy / 110.574, cx / (k * 111.320), abs(A) / 2.0   # lat, lon, km^2


def pip(lon, lat, ring):
    """Ray-casting point-in-polygon for one ring of (lon,lat)."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]; xj, yj = ring[j]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def load_towns():
    """Each town: ags, name, rings[list of (lon,lat)], centroid, bbox, area.
    Combines admin_level=8 municipalities with admin_level=6 kreisfreie Städte."""
    towns, seen = [], set()
    files = [RAW / "towns_geom.json"]
    if (RAW / "cities_geom.json").exists():
        files.append(RAW / "cities_geom.json")   # kreisfreie Städte (Heidelberg, Mannheim, …)
    for path in files:
        d = json.load(open(path, encoding="utf-8"))
        for e in d["elements"]:
            if e.get("type") != "relation":
                continue
            t = e.get("tags", {})
            ags = t.get("de:amtlicher_gemeindeschluessel")
            if not ags or ags in seen:
                continue
            ways = []
            for m in e.get("members", []):
                if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("geometry"):
                    ways.append([(p["lon"], p["lat"]) for p in m["geometry"]])
            rings = stitch_rings(ways)
            if not rings:
                continue
            clat, clon, _ = max((ring_centroid_area(r) for r in rings), key=lambda z: z[2])
            if hav(*WORK_CENTER, clat, clon) > RADIUS_KM + 5:   # small margin for city centroids
                continue
            xs = [p[0] for r in rings for p in r]; ys = [p[1] for r in rings for p in r]
            pop = t.get("population")
            seen.add(ags)
            towns.append({"ags": ags, "name": t.get("name"), "rings": rings,
                          "lat": clat, "lon": clon,
                          "bbox": (min(xs), min(ys), max(xs), max(ys)),
                          "population": int(pop) if pop and pop.isdigit() else None})
    return towns


def category(tags):
    s, a, le = tags.get("shop"), tags.get("amenity"), tags.get("leisure")
    if s in GROCERIES: return s
    if a in SCHOOLS or a in HEALTH or a in SOCIAL: return a
    if le == "park": return "park"
    return None


def assign_amenities(towns):
    d = json.load(open(RAW / "amenities_raw.json", encoding="utf-8"))
    for t in towns:
        t["_c"] = {}
    assigned = 0
    for e in d["elements"]:
        sub = category(e.get("tags", {}))
        if not sub:
            continue
        pt = elem_point(e)
        if not pt:
            continue
        la, lo = pt
        for t in towns:
            x0, y0, x1, y1 = t["bbox"]
            if lo < x0 or lo > x1 or la < y0 or la > y1:
                continue
            if any(pip(lo, la, r) for r in t["rings"]):
                t["_c"][sub] = t["_c"].get(sub, 0) + 1
                assigned += 1
                break
    print(f"  amenities assigned (point-in-polygon): {assigned}")


def load_schools():
    return [(r["name"], r["city"], float(r["lat"]), float(r["lon"]))
            for r in csv.DictReader(open(ROOT / "scripts" / "intl_schools.csv", encoding="utf-8"))]


def main():
    kre = json.load(open(OUT / "kreise.json", encoding="utf-8"))
    kby = {k["ags"]: k for k in kre["districts"]}
    towns = load_towns()
    print(f"towns in {RADIUS_KM}km belt (with boundaries): {len(towns)}")
    assign_amenities(towns)
    schools = load_schools()

    recs, feats = [], []
    for t in towns:
        kd = kby.get(t["ags"][:5], {}); km = kd.get("metrics", {}); c = t["_c"]
        grocery = sum(c.get(x, 0) for x in GROCERIES)
        school = sum(c.get(x, 0) for x in SCHOOLS)
        hsg = sum(c.get(x, 0) for x in (HEALTH | SOCIAL)) + c.get("park", 0)
        nearest = min((round(hav(t["lat"], t["lon"], s[2], s[3]), 1), s[0], s[1]) for s in schools)
        recs.append({
            "ags": t["ags"], "name": t["name"], "kreis": kd.get("name", "?"),
            "state": kd.get("state", "?"), "lat": round(t["lat"], 4), "lon": round(t["lon"], 4),
            "population": t["population"],
            "metrics": {
                "dist_work_rot": round(hav(t["lat"], t["lon"], ANCHORS["work_rot"]["lat"], ANCHORS["work_rot"]["lon"]), 1),
                "dist_work_wdf": round(hav(t["lat"], t["lon"], ANCHORS["work_wdf"]["lat"], ANCHORS["work_wdf"]["lon"]), 1),
                "dist_heidelberg": round(hav(t["lat"], t["lon"], ANCHORS["heidelberg"]["lat"], ANCHORS["heidelberg"]["lon"]), 1),
                "intl_school_km": nearest[0], "intl_school_name": f"{nearest[1]} ({nearest[2]})",
                "groceries": grocery, "schools_childcare": school, "health_social_green": hsg,
                "amenity_detail": {k: c[k] for k in sorted(c)},
                "politics": km.get("politics", {}),
                "foreign_share": km.get("foreign_share"),
                "crime_per100k": km.get("crime_per100k"),
                "landprice_eur_m2": km.get("landprice_eur_m2"),
            },
        })
        geo_rings = [[[round(x, 4), round(y, 4)] for x, y in r] for r in t["rings"]]
        feats.append({"type": "Feature", "id": t["ags"],
                      "properties": {"ags": t["ags"], "name": t["name"]},
                      "geometry": {"type": "Polygon", "coordinates": geo_rings[:1]} if len(geo_rings) == 1
                      else {"type": "MultiPolygon", "coordinates": [[r] for r in geo_rings]}})
    recs.sort(key=lambda r: r["metrics"]["dist_work_rot"])
    meta = {"anchors": ANCHORS, "radius_km": RADIUS_KM, "center": WORK_CENTER, "town_count": len(recs),
            "note": "Amenity counts: OpenStreetMap, assigned by point-in-polygon to municipality boundaries. "
                    "politics/foreign_share/crime/landprice inherited from district (coarse) and editable."}
    json.dump({"meta": meta, "towns": recs}, open(OUT / "towns.json", "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    json.dump({"type": "FeatureCollection", "features": feats},
              open(OUT / "towns.geojson", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    gro = sum(1 for r in recs if r["metrics"]["groceries"])
    print(f"Wrote {len(recs)} towns -> towns.json ({(OUT/'towns.json').stat().st_size//1024} KB), "
          f"towns.geojson ({(OUT/'towns.geojson').stat().st_size//1024} KB)")
    print(f"  with >0 groceries: {gro}/{len(recs)}")


if __name__ == "__main__":
    main()
