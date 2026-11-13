#!/usr/bin/env bash
# Download the open-data sources the dashboard is built from.
# Usage:  bash scripts/fetch_sources.sh      (run from the repo root)
# Re-run anytime to refresh, then rebuild with:  python3 -I scripts/build_data.py
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw

echo "1/2  District boundaries (BKG VG250, via jgehrcke) ..."
curl -sSL --fail -o data/raw/counties.geojson \
  "https://raw.githubusercontent.com/jgehrcke/covid-19-germany-gae/master/geodata/DE-counties.geojson"

echo "2/2  Bundestagswahl 2025 results (Die Bundeswahlleiterin) ..."
curl -sSL --fail -o data/raw/btw25_kerg2.csv \
  "https://www.bundeswahlleiterin.de/bundestagswahlen/2025/ergebnisse/opendata/btw25/csv/kerg2.csv"

echo "Done. Sources in data/raw/. Now run:  python3 -I scripts/build_data.py"
