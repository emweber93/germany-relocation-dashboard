# Where to live — commuter-belt town dashboard

An interactive dashboard that scores the **towns within ~50 km of the SAP
St. Leon-Rot / Walldorf campuses** (the realistic commuter belt, ~370 municipalities
incl. Heidelberg, Mannheim, Karlsruhe, Speyer…) against the criteria that matter for a
house move, with weights you adjust live. Static site for GitHub Pages — no server,
no build step to use it, no account.

![screenshot](docs/screenshot.png)

## What it does

- Ranks the towns by a weighted score across your criteria; re-ranks instantly as you drag sliders.
- Colours a map of the commuter belt by score; click any town for a full breakdown.
- Computes straight-line distances to your anchors: **SAP St. Leon-Rot**, **SAP Walldorf**,
  **Heidelberg**, and a **family** location you set yourself.
- Real per-town amenity counts from OpenStreetMap (groceries, schools/childcare, health/green/social),
  counted *inside each town's boundary* (point-in-polygon).
- Hard-filters by max distance (e.g. "work ≤ 20 km"), edits/overrides any value per town,
  and **exports/imports** your whole setup as JSON. Everything saves in your browser.

Your family/home location and all edits stay **in your browser** — never written to the repo.

## Criteria & data sources

| Criterion | Signal | Source | Confidence |
|---|---|---|---|
| Commute to work | avg straight-line km to SAP ROT + WDF | computed | real |
| Near Heidelberg / family | straight-line km | computed (family in-browser) | real |
| Int'l / English school | km to nearest of ~34 international schools | curated (`scripts/intl_schools.csv`) | real, coords city-approx |
| Groceries & daily shops | count in the town boundary | OpenStreetMap | real |
| Schools & childcare | schools + Kitas in the town | OpenStreetMap | real |
| Health, green & social | doctors/pharmacies/parks/restaurants in the town | OpenStreetMap | real |
| Political fit | 2025 Bundestag 2nd-vote share of your party | Die Bundeswahlleiterin | real, **by district (coarse)** |
| Internationality | foreign-resident share | destatis GENESIS (12521/12411) | real, **by district** |
| Safety | total-crime frequency (HZ /100k) | BKA PKS 2025 | real, **by district** |
| Cost (land price) | — | no free per-district source | **editable only** |

**Honesty notes:** amenity counts are raw OSM counts (log-scaled in the score so a big city
doesn't swamp everything, but larger towns still score higher — weight to taste). Political,
internationality and safety are only available per *district*, inherited by a district's towns.
**Cost** stays editable: land price is only published per *Bundesland* (too coarse to tell towns
in one state apart), ImmoScout24 can't be scraped (ToS + bot-blocking), and Mietspiegel are
scattered per-city PDFs — so type rent/price figures into a town's detail panel as you research.

## Rebuild / refresh the data

Pure Python standard library — **no dependencies**. The committed `data/*.json` already hold
real values, so the site works with zero setup. To refresh:

```bash
bash scripts/fetch_sources.sh          # boundaries, election CSV, OSM towns/cities/amenities
python3 -I scripts/build_data.py       # -> data/kreise.json   (district layer, for inheritance)
# district indicators (optional, needs a free destatis account for internationality):
#   download BKA crime xlsx into data/raw/bka_kreise_hz.xlsx (see scripts/enrich_kreise.py header)
export GENESIS_USER=... GENESIS_PASS=...   # https://www-genesis.destatis.de → Registrierung (alphanumeric pw!)
python3 -I scripts/fetch_destatis.py   # -> data/raw/foreign_share.csv + population.csv
python3 -I scripts/enrich_kreise.py    # merge crime + foreign share into kreise.json
python3 -I scripts/build_towns.py      # -> data/towns.json + data/towns.geojson  (what the site serves)
```

`data/raw/` is git-ignored. OSM (Overpass) is rate-limited and sometimes returns 502 when busy —
`fetch_sources.sh` retries across mirrors; just re-run if one step fails. GENESIS REST auth is
header-based (see `scripts/fetch_destatis.py`). To change the radius or offices, edit the
constants atop `scripts/build_towns.py` (and the bbox/anchors in `fetch_sources.sh`).

## Run locally

```bash
python3 -m http.server 8777    # then open http://localhost:8777
```

## Deploy on GitHub Pages

Push to a public repo → **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.
The site is the repo root (`index.html`).

## Tech & licenses

Vanilla HTML/CSS/JS + [Leaflet](https://leafletjs.com) (CDN). No framework, no tracking.

- Town/city boundaries & amenities © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), via Overpass.
- District boundaries © [BKG](https://www.bkg.bund.de) (VG250). Election © [Die Bundeswahlleiterin](https://www.bundeswahlleiterin.de) (dl-de/by-2-0).
