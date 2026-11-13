# Where to live in Germany — district dashboard

An interactive dashboard that scores every German district (*Landkreis* /
*kreisfreie Stadt*, ~400) against the criteria that matter for a house move, with
weights you adjust live. Built to run as a static site on GitHub Pages — no server,
no build step, no account needed to use it.

![screenshot](docs/screenshot.png)

## What it does

- Ranks all districts by a weighted score across your criteria.
- Re-ranks instantly as you drag weight sliders.
- Colours a map of Germany by score and lets you click any district for a breakdown.
- Computes straight-line distances to your anchors: **SAP St. Leon-Rot (ROT)**,
  **SAP Walldorf (WDF)**, **Heidelberg**, and a **family** location you set yourself.
- Hard-filters by maximum distance (e.g. "work ≤ 40 km").
- Lets you type/override any value per district and **export/import** your whole
  setup as a JSON file. Everything is saved in your browser's local storage.

Your family/home location and all your edits stay **in your browser** — they are
never written to the repository or uploaded anywhere.

## Criteria & data sources

| Criterion | Signal | Source | Confidence |
|---|---|---|---|
| Commute to work | avg straight-line km to SAP ROT + WDF | computed | real |
| Near Heidelberg | straight-line km | computed | real |
| Near family | straight-line km to your anchor | computed in browser | real |
| Int'l / English school | km to nearest of ~34 international schools | curated (`scripts/intl_schools.csv`) | real, coords city-approx |
| Political fit | 2025 Bundestag 2nd-vote share of your chosen party | Die Bundeswahlleiterin | real but **coarse (per state)** |
| Nature / green space | non-built-up land share | GENESIS (needs token) | **empty — editable** |
| Internationality | foreign-population share | GENESIS (needs token) | **empty — editable** |
| Safety | crime frequency /100k | BKA PKS | **empty — editable** |
| Low cost | building-land price proxy €/m² | GENESIS (needs token) | **empty — editable** |
| Population / density | inhabitants; area is computed from geometry | Wikidata | auto-fills on build (area already real) |

**Honesty notes:** political data is only one value per *state* (16 values spread
over ~400 districts) — directionally useful, not fine-grained. The four GENESIS
fields ship empty: fill them per district in the UI, or wire a token (below).
Housing *cost* uses a land-price proxy, not rents.

## Rebuild / refresh the data

Pure Python standard library — **no dependencies to install**.

```bash
bash scripts/fetch_sources.sh        # download boundaries + election CSV into data/raw/
python3 -I scripts/build_data.py     # -> data/kreise.json + data/kreise.geojson
```

`data/raw/` is git-ignored; the generated `data/kreise.json` and `data/kreise.geojson`
are committed so the site works with zero setup.

### Filling the GENESIS fields (optional)

The four empty fields need a free [regionalstatistik.de](https://www.regionalstatistik.de)
account. `scripts/fetch_genesis.py` is a documented template for it (the REST pattern
is right; table codes need a one-time check). Easiest alternative: just type the
values into each district's detail panel — they're saved locally and exportable.

## Run locally

```bash
python3 -m http.server 8777
# open http://localhost:8777
```

## Deploy on GitHub Pages

Push to a public repo, then **Settings → Pages → Source: Deploy from a branch →
`main` / `/ (root)`**. The site is the repo root (`index.html`).

## Tech & licenses

Vanilla HTML/CSS/JS + [Leaflet](https://leafletjs.com) (via CDN). No framework, no tracking.

- District boundaries © [BKG](https://www.bkg.bund.de) (VG250), via the jgehrcke dataset.
- Election results © [Die Bundeswahlleiterin](https://www.bundeswahlleiterin.de)
  (Datenlizenz Deutschland – Namensnennung 2.0).
- Population from [Wikidata](https://www.wikidata.org) (CC0).
