#!/usr/bin/env bash
# Download every open-data source the dashboard is built from.
# Usage:  bash scripts/fetch_sources.sh      (run from the repo root)
# Then rebuild:  python3 -I scripts/build_data.py && python3 -I scripts/build_towns.py
#
# Overpass (OpenStreetMap) is rate-limited and occasionally returns 502 when busy;
# the town/city/amenity fetches retry across mirrors. Re-run if one still fails.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw
UA="relocation-dashboard/1.0 (personal project)"
BBOX="48.83,7.94,49.73,9.32"           # ~50 km box around the SAP offices
OVERPASS=( "https://overpass-api.de/api/interpreter" \
           "https://overpass.private.coffee/api/interpreter" \
           "https://overpass.kumi.systems/api/interpreter" )

# 8-digit AGS of the 11 kreisfreie Städte within range (Heidelberg, Mannheim, Karlsruhe, …)
CITY_RE='^(08221000|07318000|08222000|07314000|08212000|07311000|07316000|07313000|08121000|08231000|07319000)$'

overpass() {           # $1 = query, $2 = output file
  local q="$1" out="$2" code sz
  for attempt in 1 2 3 4 5; do
    for ep in "${OVERPASS[@]}"; do
      code=$(curl -sS --max-time 200 -A "$UA" -H "Accept: application/json" \
             -G --data-urlencode "data=$q" "$ep" -o "$out" -w "%{http_code}" || echo 000)
      sz=$(wc -c < "$out" 2>/dev/null || echo 0)
      echo "  [$code, ${sz}B] $ep"
      [ "$code" = "200" ] && [ "$sz" -gt 5000 ] && return 0
    done
    echo "  retry $attempt ..."
  done
  echo "  FAILED: $out"; return 1
}

echo "1/5  District boundaries (BKG VG250, via jgehrcke) ..."
curl -sSL --fail -o data/raw/counties.geojson \
  "https://raw.githubusercontent.com/jgehrcke/covid-19-germany-gae/master/geodata/DE-counties.geojson"

echo "2/5  Bundestagswahl 2025 results (Die Bundeswahlleiterin) ..."
curl -sSL --fail -o data/raw/btw25_kerg2.csv \
  "https://www.bundeswahlleiterin.de/bundestagswahlen/2025/ergebnisse/opendata/btw25/csv/kerg2.csv"

echo "3/5  Municipality boundaries, admin_level=8 (OpenStreetMap) ..."
overpass "[out:json][timeout:240];relation[\"boundary\"=\"administrative\"][\"admin_level\"=\"8\"](${BBOX});out geom;" data/raw/towns_geom.json

echo "4/5  Kreisfreie-Stadt boundaries, admin_level=6 (OpenStreetMap) ..."
overpass "[out:json][timeout:180];relation[\"admin_level\"=\"6\"][\"de:amtlicher_gemeindeschluessel\"~\"${CITY_RE}\"](${BBOX});out geom;" data/raw/cities_geom.json

echo "5/5  Amenities: shops, schools, health, parks, social (OpenStreetMap) ..."
overpass "[out:json][timeout:180];(node[\"shop\"~\"^(supermarket|convenience|bakery|butcher|greengrocer)\$\"](${BBOX});node[\"amenity\"~\"^(school|kindergarten|doctors|pharmacy|hospital|clinic|restaurant|cafe|bar|pub)\$\"](${BBOX});way[\"amenity\"~\"^(school|hospital|clinic)\$\"](${BBOX});nwr[\"leisure\"~\"^(park|garden)\$\"](${BBOX}););out center tags;" data/raw/amenities_raw.json

echo "Done. Now:  python3 -I scripts/build_data.py && python3 -I scripts/build_towns.py"
