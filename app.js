/* Where to live in Germany — district dashboard
   Vanilla JS. Data: data/kreise.json + data/kreise.geojson. Settings: localStorage. */
'use strict';
const LS_KEY = 'reloc.v1';
const GCOL = ['#3a4a63', '#4a74b0', '#5aa0c0', '#6fc08a', '#9ed659'];

const avg = (a, b) => (a == null || b == null) ? (a ?? b ?? null) : (a + b) / 2;
function haversine(la1, lo1, la2, lo2) {
  const p = Math.PI / 180, R = 6371.0088;
  const a = 0.5 - Math.cos((la2 - la1) * p) / 2 +
    Math.cos(la1 * p) * Math.cos(la2 * p) * (1 - Math.cos((lo2 - lo1) * p)) / 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const gm = (d, k) => {
  const o = state.overrides[d.ags];
  if (o && o[k] != null && o[k] !== '') return +o[k];
  return d.metrics[k];
};

const CRITERIA = [
  { id: 'work', label: 'Commute to work', dir: 'low', unit: 'km', dist: true,
    value: d => avg(gm(d, 'dist_work_rot'), gm(d, 'dist_work_wdf')),
    help: 'Straight-line km (avg of SAP ROT + WDF campuses).' },
  { id: 'heidelberg', label: 'Near Heidelberg', dir: 'low', unit: 'km', dist: true,
    value: d => gm(d, 'dist_heidelberg'), help: 'Straight-line km to Heidelberg.' },
  { id: 'family', label: 'Near family', dir: 'low', unit: 'km', dist: true, needs: 'set a family anchor',
    value: d => state.family ? haversine(d.lat, d.lon, state.family.lat, state.family.lon) : null,
    help: 'Straight-line km to the family location you set below.' },
  { id: 'intl_school', label: "Int'l / English school", dir: 'low', unit: 'km',
    value: d => gm(d, 'intl_school_km'),
    help: 'Distance to nearest international / English-medium school (curated list).' },
  { id: 'politics', label: 'Political fit', dir: 'high', unit: '%', needs: 'pick a party above',
    value: d => state.politicsTarget ? (d.metrics.politics[state.politicsTarget] ?? null) : null,
    help: '2025 Bundestag second-vote share of your chosen party, by state.' },
  { id: 'nature', label: 'Nature / green space', dir: 'high', unit: '%', ovkey: 'green_share',
    value: d => gm(d, 'green_share'), help: 'Share of non-built-up land. Needs data token — editable per district.' },
  { id: 'international', label: 'Internationality', dir: 'high', unit: '%', ovkey: 'foreign_share',
    value: d => gm(d, 'foreign_share'), help: 'Foreign-population share. Needs data token — editable per district.' },
  { id: 'safety', label: 'Safety (low crime)', dir: 'low', unit: '/100k', ovkey: 'crime_per100k',
    value: d => gm(d, 'crime_per100k'), help: 'Crime frequency per 100k. Needs data token — editable per district.' },
  { id: 'cost', label: 'Low cost (land price)', dir: 'low', unit: '€/m²', ovkey: 'landprice_eur_m2',
    value: d => gm(d, 'landprice_eur_m2'), help: 'Building-land price proxy. Needs data token — editable per district.' },
];
const CRIT = Object.fromEntries(CRITERIA.map(c => [c.id, c]));
const DEFAULTS = { work: 8, heidelberg: 5, family: 5, intl_school: 4, politics: 0, nature: 3, international: 3, safety: 4, cost: 4 };

let DATA = null, districts = [], map = null, geoLayer = null;
const layerByAgs = {}, rowByAgs = {};
let state = loadState();

function loadState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) {}
  return {
    weights: Object.assign({}, DEFAULTS, s.weights || {}),
    limits: s.limits || {},            // {critId: maxKm}
    politicsTarget: s.politicsTarget || '',
    family: s.family || null,          // {lat,lon,label}
    overrides: s.overrides || {},      // {ags:{key:val}}
    sort: s.sort || { key: 'score', dir: 'desc' },
  };
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

/* ---------- scoring ---------- */
function activeCriteria() {
  return CRITERIA.filter(c => (state.weights[c.id] || 0) > 0 &&
    !(c.id === 'politics' && !state.politicsTarget) &&
    !(c.id === 'family' && !state.family));
}
function passesFilters(d) {
  for (const c of CRITERIA) {
    if (!c.dist) continue;
    const lim = state.limits[c.id];
    if (lim == null || lim === '') continue;
    const v = c.value(d);
    if (v != null && v > +lim) return false;
  }
  return true;
}
function compute() {
  const act = activeCriteria();
  const visible = districts.filter(passesFilters);
  const ranges = {};
  for (const c of act) {
    let mn = Infinity, mx = -Infinity;
    for (const d of visible) { const v = c.value(d); if (v == null) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
    ranges[c.id] = { mn, mx };
  }
  for (const d of districts) {
    d._norm = {}; let num = 0, den = 0;
    for (const c of act) {
      const v = c.value(d); if (v == null) continue;
      const { mn, mx } = ranges[c.id];
      let n = mx === mn ? 1 : (c.dir === 'low' ? (mx - v) / (mx - mn) : (v - mn) / (mx - mn));
      d._norm[c.id] = n;
      const w = state.weights[c.id]; num += w * n; den += w;
    }
    d._score = den ? (num / den) * 100 : null;
    d._visible = passesFilters(d);
  }
  const vis = districts.filter(d => d._visible);
  const { key, dir } = state.sort, sgn = dir === 'asc' ? 1 : -1;
  vis.sort((a, b) => sgn * cmp(valFor(a, key), valFor(b, key)));
  vis.forEach((d, i) => d._rank = i + 1);
  return vis;
}
function cmp(a, b) {
  const an = a == null, bn = b == null;
  if (an && bn) return 0; if (an) return 1; if (bn) return -1; // nulls last
  return typeof a === 'string' ? a.localeCompare(b) : a - b;
}
function valFor(d, key) {
  if (key === 'score') return d._score;
  if (key === 'rank') return d._rank;
  if (key === 'name') return d.name;
  if (key === 'state') return d.state;
  if (key === 'dist_work') return CRIT.work.value(d);
  if (key === 'dist_family') return CRIT.family.value(d);
  if (key === 'intl_school_km') return d.metrics.intl_school_km;
  if (key === 'dist_heidelberg') return d.metrics.dist_heidelberg;
  return null;
}
const colorFor = s => s == null ? '#2a2f3a' : GCOL[Math.min(4, Math.floor(s / 20))];

/* ---------- rendering ---------- */
function fmt(v, dp = 0) { return v == null ? '—' : (+v).toLocaleString('en', { maximumFractionDigits: dp }); }

function renderWeights() {
  const host = document.getElementById('weights'); host.innerHTML = '';
  for (const c of CRITERIA) {
    const w = state.weights[c.id] || 0;
    const el = document.createElement('div'); el.className = 'crit';
    const need = c.needs && ((c.id === 'politics' && !state.politicsTarget) || (c.id === 'family' && !state.family))
      ? `<span class="nodata">(${c.needs})</span>` : '';
    const nod = c.ovkey && districts.every(d => c.value(d) == null)
      ? `<span class="nodata">no data yet — add in a district's detail panel</span>` : '';
    el.innerHTML = `<div class="top"><span class="nm">${c.label} ${need}</span><span class="wt">${w}</span></div>
      <input type="range" min="0" max="10" step="1" value="${w}" data-w="${c.id}">
      <div class="meta">${c.help} ${nod}</div>
      ${c.dist ? `<div class="meta">limit: <input type="number" min="0" step="10" placeholder="no max" style="width:90px" value="${state.limits[c.id] ?? ''}" data-lim="${c.id}"> km</div>` : ''}`;
    host.appendChild(el);
  }
  host.querySelectorAll('[data-w]').forEach(r => r.addEventListener('input', e => {
    state.weights[e.target.dataset.w] = +e.target.value;
    e.target.closest('.crit').querySelector('.wt').textContent = e.target.value; save(); refresh();
  }));
  host.querySelectorAll('[data-lim]').forEach(r => r.addEventListener('input', e => {
    const v = e.target.value; state.limits[e.target.dataset.lim] = v === '' ? '' : +v; save(); refresh();
  }));
}

function renderAnchors() {
  const host = document.getElementById('anchors'); host.innerHTML = '';
  for (const [k, a] of Object.entries(DATA.meta.anchors)) {
    host.insertAdjacentHTML('beforeend',
      `<div class="anchor"><div class="lbl">${a.label}</div><div class="st">${a.lat.toFixed(3)}, ${a.lon.toFixed(3)} · seeded</div></div>`);
  }
  const fam = state.family;
  host.insertAdjacentHTML('beforeend', `<div class="anchor">
    <div class="lbl">Family <button class="link" id="famClear">${fam ? 'clear' : ''}</button></div>
    <div class="st" id="famSt">${fam ? `${fam.label} · ${fam.lat.toFixed(3)}, ${fam.lon.toFixed(3)}` : 'not set — only stored in this browser'}</div>
    <label class="row">Town / address in Germany<input id="famQ" placeholder="e.g. Tübingen"></label>
    <button id="famGo">Locate</button>
    <label class="row" style="margin-top:6px">…or lat, lon<input id="famLL" placeholder="48.52, 9.06"></label>
  </div>`);
  document.getElementById('famGo').onclick = geocodeFamily;
  document.getElementById('famLL').addEventListener('change', e => {
    const m = e.target.value.split(/[ ,]+/).map(Number);
    if (m.length === 2 && m.every(n => !isNaN(n))) setFamily({ lat: m[0], lon: m[1], label: 'manual' });
  });
  const clr = document.getElementById('famClear'); if (clr) clr.onclick = () => { state.family = null; save(); renderAnchors(); renderWeights(); refresh(); };
}
async function geocodeFamily() {
  const q = document.getElementById('famQ').value.trim(); if (!q) return;
  const st = document.getElementById('famSt'); st.textContent = 'locating…';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!j.length) { st.textContent = 'not found — try a nearby larger town or use lat, lon'; return; }
    setFamily({ lat: +j[0].lat, lon: +j[0].lon, label: q });
  } catch (e) { st.textContent = 'lookup failed (offline?) — use lat, lon instead'; }
}
function setFamily(f) { state.family = f; save(); renderAnchors(); renderWeights(); refresh(); }

function renderPolitics() {
  const sel = document.getElementById('politicsTarget');
  const parties = new Set();
  districts.forEach(d => Object.keys(d.metrics.politics).forEach(p => parties.add(p)));
  sel.innerHTML = '<option value="">— off —</option>' +
    [...parties].sort().map(p => `<option value="${p}" ${p === state.politicsTarget ? 'selected' : ''}>${p}</option>`).join('');
  sel.onchange = () => { state.politicsTarget = sel.value; save(); renderWeights(); refresh(); };
}

function renderTable(vis) {
  const tb = document.querySelector('#table tbody'); tb.innerHTML = '';
  document.getElementById('count').textContent = `${vis.length} of ${districts.length} districts`;
  const frag = document.createDocumentFragment();
  for (const d of vis) {
    const tr = document.createElement('tr'); tr.dataset.ags = d.ags;
    const sc = d._score;
    tr.innerHTML = `<td>${d._rank}</td><td>${d.name}</td><td>${d.state}</td>
      <td class="score">${sc == null ? '—' : sc.toFixed(0)}<span class="bar" style="width:${sc == null ? 0 : Math.round(sc / 2)}px;background:${colorFor(sc)}"></span></td>
      <td>${fmt(CRIT.work.value(d))}</td><td>${fmt(d.metrics.dist_heidelberg)}</td>
      <td>${fmt(CRIT.family.value(d))}</td><td>${fmt(d.metrics.intl_school_km)}</td>`;
    tr.onclick = () => openDetail(d.ags);
    frag.appendChild(tr); rowByAgs[d.ags] = tr;
  }
  tb.appendChild(frag);
  document.querySelectorAll('#table th').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'desc' ? 'asc' : 'desc' };
    save(); refresh();
  });
}

function styleMap() {
  if (!geoLayer) return;
  geoLayer.eachLayer(l => {
    const d = l._d; if (!d) return;
    l.setStyle({ fillColor: colorFor(d._visible ? d._score : null), fillOpacity: d._visible ? 0.82 : 0.12,
      weight: 0.5, color: '#0b0d11' });
  });
}

function openDetail(ags) {
  const d = districts.find(x => x.ags === ags); if (!d) return;
  document.querySelectorAll('tbody tr.sel').forEach(t => t.classList.remove('sel'));
  if (rowByAgs[ags]) { rowByAgs[ags].classList.add('sel'); rowByAgs[ags].scrollIntoView({ block: 'nearest' }); }
  if (layerByAgs[ags]) map.fitBounds(layerByAgs[ags].getBounds(), { maxZoom: 9, padding: [40, 40] });
  const body = document.getElementById('detailBody');
  const act = activeCriteria();
  const rows = CRITERIA.map(c => {
    const v = c.value(d);
    const contrib = d._norm && d._norm[c.id] != null && act.includes(c)
      ? `<span class="contrib">score ${(d._norm[c.id] * 100).toFixed(0)}/100 · w${state.weights[c.id]}</span>` : '';
    if (c.ovkey) {
      const ov = (state.overrides[ags] || {})[c.ovkey];
      return `<div class="mrow"><span class="k">${c.label}<br>${contrib}</span>
        <input type="number" step="any" placeholder="${v == null ? 'add value' : v}" value="${ov ?? ''}" data-ov="${c.ovkey}"> <span class="v">${c.unit}</span></div>`;
    }
    return `<div class="mrow"><span class="k">${c.label}<br>${contrib}</span><span class="v">${fmt(v, 1)} ${c.unit}</span></div>`;
  }).join('');
  body.innerHTML = `<h3>${d.name}</h3><p class="sub">${d.type} · ${d.state} · score ${d._score == null ? '—' : d._score.toFixed(0)}/100</p>
    <div class="mrow"><span class="k">Area</span><span class="v">${fmt(d.area_km2)} km²</span></div>
    <div class="mrow"><span class="k">Population</span><span class="v">${fmt(d.metrics.population)}</span></div>
    ${rows}
    <p class="hint" style="margin-top:14px">Nearest int'l school: ${d.metrics.intl_school_name}.<br>
    Numbers you type above are saved in this browser and override the dataset.</p>`;
  body.querySelectorAll('[data-ov]').forEach(inp => inp.addEventListener('change', e => {
    const key = e.target.dataset.ov, val = e.target.value;
    state.overrides[ags] = state.overrides[ags] || {};
    if (val === '') delete state.overrides[ags][key]; else state.overrides[ags][key] = +val;
    save(); renderWeights(); refresh(); openDetail(ags);
  }));
  document.getElementById('detail').classList.remove('hidden');
}

function refresh() { const vis = compute(); renderTable(vis); styleMap(); }

/* ---------- init ---------- */
async function init() {
  DATA = await (await fetch('data/kreise.json')).json();
  districts = DATA.districts;
  renderWeights(); renderPolitics(); renderAnchors();

  map = L.map('map', { preferCanvas: true, attributionControl: true }).setView([51.2, 10.4], 6);
  map.attributionControl.addAttribution('Boundaries © BKG (VG250) · election © Bundeswahlleiterin');
  try {
    const gj = await (await fetch('data/kreise.geojson')).json();
    const byAgs = Object.fromEntries(districts.map(d => [d.ags, d]));
    geoLayer = L.geoJSON(gj, {
      style: { weight: 0.5, color: '#0b0d11', fillOpacity: 0.8 },
      onEachFeature: (f, l) => {
        const d = byAgs[f.properties.ags]; l._d = d; if (d) layerByAgs[d.ags] = l;
        l.on('click', () => d && openDetail(d.ags));
        l.bindTooltip(f.properties.name, { sticky: true });
      },
    }).addTo(map);
  } catch (e) { console.warn('geojson load failed', e); }

  document.getElementById('detailClose').onclick = () => document.getElementById('detail').classList.add('hidden');
  document.getElementById('allOff').onclick = () => { CRITERIA.forEach(c => state.weights[c.id] = 0); save(); renderWeights(); refresh(); };
  document.getElementById('resetBtn').onclick = () => { if (confirm('Reset all weights, filters, anchors and edits?')) { localStorage.removeItem(LS_KEY); state = loadState(); renderWeights(); renderPolitics(); renderAnchors(); refresh(); } };
  document.getElementById('exportBtn').onclick = exportSettings;
  document.getElementById('importFile').addEventListener('change', importSettings);
  document.getElementById('helpBtn').onclick = () => { document.getElementById('helpBody').innerHTML = HELP; document.getElementById('help').classList.remove('hidden'); };
  document.getElementById('helpClose').onclick = () => document.getElementById('help').classList.add('hidden');

  refresh();
}
function exportSettings() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'relocation-settings.json'; a.click(); URL.revokeObjectURL(a.href);
}
function importSettings(e) {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { try { localStorage.setItem(LS_KEY, rd.result); state = loadState(); renderWeights(); renderPolitics(); renderAnchors(); refresh(); } catch (x) { alert('Invalid settings file'); } };
  rd.readAsText(f);
}
const HELP = `<h2>How scoring works</h2>
<p>Each criterion's values are normalised 0–100 across the districts currently shown, in the right direction
(closer / safer / greener = better). Your weights combine them into one score. Criteria with no data, or weight 0, are ignored —
so adding data only ever helps.</p>
<h3>Data sources & honesty</h3>
<table><tr><th>Criterion</th><th>Source</th><th>Note</th></tr>
<tr><td>Commute / Heidelberg / Family</td><td>Computed</td><td>Straight-line km from district centre. Family stays in your browser.</td></tr>
<tr><td>Int'l / English school</td><td>Curated list</td><td>Nearest of ~34 international schools; city-approximate coords.</td></tr>
<tr><td>Political fit</td><td>Bundeswahlleiterin 2025</td><td>Second-vote share by <em>state</em> — coarse (one value per state).</td></tr>
<tr><td>Nature, Internationality, Safety, Cost</td><td>GENESIS (pending token)</td><td>Empty for now — type values per district, or refresh via the build script.</td></tr>
<tr><td>Population / density</td><td>Wikidata</td><td>Auto-fills on next build run; area is already real.</td></tr></table>
<p>Boundaries © BKG (VG250). Everything is adjustable and saved locally; use Export to back up or share your weighting.</p>`;
init();
