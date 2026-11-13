/* Where to live — commuter-belt TOWN dashboard
   Vanilla JS. Data: data/towns.json + data/towns.geojson. Settings: localStorage. */
'use strict';
const LS_KEY = 'reloc.towns.v1';
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
    value: d => avg(d.metrics.dist_work_rot, d.metrics.dist_work_wdf),
    help: 'Straight-line km (avg of SAP ROT + WDF).' },
  { id: 'heidelberg', label: 'Near Heidelberg', dir: 'low', unit: 'km', dist: true,
    value: d => d.metrics.dist_heidelberg, help: 'Straight-line km to Heidelberg.' },
  { id: 'family', label: 'Near family', dir: 'low', unit: 'km', dist: true, needs: 'set a family anchor',
    value: d => state.family ? haversine(d.lat, d.lon, state.family.lat, state.family.lon) : null,
    help: 'Straight-line km to the family location you set below.' },
  { id: 'intl_school', label: "Int'l / English school", dir: 'low', unit: 'km',
    value: d => d.metrics.intl_school_km, help: 'Distance to nearest international / English-medium school.' },
  { id: 'groceries', label: 'Groceries & daily shops', dir: 'high', unit: '', amen: true,
    value: d => gm(d, 'groceries'), help: 'Supermarkets, bakeries, butchers, etc. in the town (OSM count).' },
  { id: 'schools_childcare', label: 'Schools & childcare', dir: 'high', unit: '', amen: true,
    value: d => gm(d, 'schools_childcare'), help: 'Schools + Kitas in the town (OSM count).' },
  { id: 'health_social_green', label: 'Health, green & social', dir: 'high', unit: '', amen: true,
    value: d => gm(d, 'health_social_green'), help: 'Doctors, pharmacies, parks, restaurants/cafés (OSM count).' },
  { id: 'politics', label: 'Political fit', dir: 'high', unit: '%', needs: 'pick a party above',
    value: d => state.politicsTarget ? (d.metrics.politics[state.politicsTarget] ?? null) : null,
    help: '2025 Bundestag 2nd-vote share of your party — by district (coarse).' },
  { id: 'international', label: 'Internationality', dir: 'high', unit: '%', ovkey: 'foreign_share',
    value: d => gm(d, 'foreign_share'), help: 'Foreign-population share (district-level). Editable.' },
  { id: 'safety', label: 'Safety (low crime)', dir: 'low', unit: '/100k', ovkey: 'crime_per100k',
    value: d => gm(d, 'crime_per100k'), help: 'Crime frequency (district-level). Editable.' },
  { id: 'cost', label: 'Low cost (land price)', dir: 'low', unit: '€/m²', ovkey: 'landprice_eur_m2',
    value: d => gm(d, 'landprice_eur_m2'), help: 'Building-land price proxy (district-level). Editable.' },
];
const CRIT = Object.fromEntries(CRITERIA.map(c => [c.id, c]));
const DEFAULTS = { work: 8, heidelberg: 5, family: 5, intl_school: 3, groceries: 4,
  schools_childcare: 4, health_social_green: 3, politics: 0, international: 2, safety: 4, cost: 4 };

let DATA = null, towns = [], map = null, geoLayer = null;
const layerByAgs = {}, rowByAgs = {};
let state = loadState();

function loadState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) {}
  return {
    weights: Object.assign({}, DEFAULTS, s.weights || {}),
    limits: s.limits || {}, politicsTarget: s.politicsTarget || '',
    family: s.family || null, overrides: s.overrides || {},
    sort: s.sort || { key: 'score', dir: 'desc' },
  };
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

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
  const visible = towns.filter(passesFilters);
  const T = (c, v) => c.amen ? Math.log1p(v) : v;   // diminishing returns for amenity counts
  const ranges = {};
  for (const c of act) {
    let mn = Infinity, mx = -Infinity;
    for (const d of visible) { const v = c.value(d); if (v == null) continue; const t = T(c, v); if (t < mn) mn = t; if (t > mx) mx = t; }
    ranges[c.id] = { mn, mx };
  }
  for (const d of towns) {
    d._norm = {}; let num = 0, den = 0;
    for (const c of act) {
      const v = c.value(d); if (v == null) continue;
      const { mn, mx } = ranges[c.id]; const t = T(c, v);
      const n = mx === mn ? 1 : (c.dir === 'low' ? (mx - t) / (mx - mn) : (t - mn) / (mx - mn));
      d._norm[c.id] = n; num += state.weights[c.id] * n; den += state.weights[c.id];
    }
    d._score = den ? (num / den) * 100 : null;
    d._visible = passesFilters(d);
  }
  const vis = towns.filter(d => d._visible);
  const { key, dir } = state.sort, sgn = dir === 'asc' ? 1 : -1;
  vis.sort((a, b) => sgn * cmp(valFor(a, key), valFor(b, key)));
  vis.forEach((d, i) => d._rank = i + 1);
  return vis;
}
function cmp(a, b) {
  const an = a == null, bn = b == null;
  if (an && bn) return 0; if (an) return 1; if (bn) return -1;
  return typeof a === 'string' ? a.localeCompare(b) : a - b;
}
function valFor(d, key) {
  if (key === 'score') return d._score;
  if (key === 'rank') return d._rank;
  if (key === 'name') return d.name;
  if (key === 'kreis') return d.kreis;
  if (key === 'dist_work') return CRIT.work.value(d);
  if (key === 'dist_family') return CRIT.family.value(d);
  if (key === 'dist_heidelberg') return d.metrics.dist_heidelberg;
  if (key === 'groceries') return d.metrics.groceries;
  if (key === 'schools_childcare') return d.metrics.schools_childcare;
  return null;
}
const colorFor = s => s == null ? '#2a2f3a' : GCOL[Math.min(4, Math.floor(s / 20))];
const fmt = (v, dp = 0) => v == null ? '—' : (+v).toLocaleString('en', { maximumFractionDigits: dp });

function renderWeights() {
  const host = document.getElementById('weights'); host.innerHTML = '';
  for (const c of CRITERIA) {
    const w = state.weights[c.id] || 0;
    const need = c.needs && ((c.id === 'politics' && !state.politicsTarget) || (c.id === 'family' && !state.family))
      ? `<span class="nodata">(${c.needs})</span>` : '';
    const nod = c.ovkey && towns.every(d => c.value(d) == null)
      ? `<span class="nodata">no data yet — add in a town's detail panel</span>` : '';
    const el = document.createElement('div'); el.className = 'crit';
    el.innerHTML = `<div class="top"><span class="nm">${c.label} ${need}</span><span class="wt">${w}</span></div>
      <input type="range" min="0" max="10" step="1" value="${w}" data-w="${c.id}">
      <div class="meta">${c.help} ${nod}</div>
      ${c.dist ? `<div class="meta">limit: <input type="number" min="0" step="5" placeholder="no max" style="width:90px" value="${state.limits[c.id] ?? ''}" data-lim="${c.id}"> km</div>` : ''}`;
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
  for (const a of Object.values(DATA.meta.anchors))
    host.insertAdjacentHTML('beforeend',
      `<div class="anchor"><div class="lbl">${a.label}</div><div class="st">${a.lat.toFixed(3)}, ${a.lon.toFixed(3)} · seeded</div></div>`);
  const fam = state.family;
  host.insertAdjacentHTML('beforeend', `<div class="anchor">
    <div class="lbl">Family <button class="link" id="famClear">${fam ? 'clear' : ''}</button></div>
    <div class="st" id="famSt">${fam ? `${fam.label} · ${fam.lat.toFixed(3)}, ${fam.lon.toFixed(3)}` : 'not set — only stored in this browser'}</div>
    <label class="row">Town / address<input id="famQ" placeholder="e.g. Tübingen"></label>
    <button id="famGo">Locate</button>
    <label class="row" style="margin-top:6px">…or lat, lon<input id="famLL" placeholder="48.52, 9.06"></label></div>`);
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
    if (!j.length) { st.textContent = 'not found — try a larger nearby town or use lat, lon'; return; }
    setFamily({ lat: +j[0].lat, lon: +j[0].lon, label: q });
  } catch (e) { st.textContent = 'lookup failed — use lat, lon instead'; }
}
function setFamily(f) { state.family = f; save(); renderAnchors(); renderWeights(); refresh(); }

function renderPolitics() {
  const sel = document.getElementById('politicsTarget');
  const parties = new Set();
  towns.forEach(d => Object.keys(d.metrics.politics).forEach(p => parties.add(p)));
  sel.innerHTML = '<option value="">— off —</option>' +
    [...parties].sort().map(p => `<option value="${p}" ${p === state.politicsTarget ? 'selected' : ''}>${p}</option>`).join('');
  sel.onchange = () => { state.politicsTarget = sel.value; save(); renderWeights(); refresh(); };
}

function renderTable(vis) {
  const tb = document.querySelector('#table tbody'); tb.innerHTML = '';
  document.getElementById('count').textContent = `${vis.length} of ${towns.length} towns`;
  const frag = document.createDocumentFragment();
  for (const d of vis) {
    const tr = document.createElement('tr'); tr.dataset.ags = d.ags;
    const sc = d._score;
    tr.innerHTML = `<td>${d._rank}</td><td>${d.name}</td><td>${d.kreis}</td>
      <td class="score">${sc == null ? '—' : sc.toFixed(0)}<span class="bar" style="width:${sc == null ? 0 : Math.round(sc / 2)}px;background:${colorFor(sc)}"></span></td>
      <td>${fmt(CRIT.work.value(d), 1)}</td><td>${fmt(d.metrics.dist_heidelberg, 1)}</td>
      <td>${fmt(CRIT.family.value(d), 1)}</td><td>${fmt(d.metrics.groceries)}</td><td>${fmt(d.metrics.schools_childcare)}</td>`;
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
    l.setStyle({ fillColor: colorFor(d._visible ? d._score : null), fillOpacity: d._visible ? 0.8 : 0.1,
      weight: 0.6, color: '#0b0d11' });
  });
}

function openDetail(ags) {
  const d = towns.find(x => x.ags === ags); if (!d) return;
  document.querySelectorAll('tbody tr.sel').forEach(t => t.classList.remove('sel'));
  if (rowByAgs[ags]) { rowByAgs[ags].classList.add('sel'); rowByAgs[ags].scrollIntoView({ block: 'nearest' }); }
  if (layerByAgs[ags]) map.fitBounds(layerByAgs[ags].getBounds(), { maxZoom: 12, padding: [30, 30] });
  const act = activeCriteria();
  const ad = d.metrics.amenity_detail || {};
  const adStr = Object.keys(ad).length ? Object.entries(ad).map(([k, v]) => `${k} ${v}`).join(' · ') : 'none mapped';
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
  const body = document.getElementById('detailBody');
  body.innerHTML = `<h3>${d.name}</h3><p class="sub">${d.kreis} · ${d.state} · score ${d._score == null ? '—' : d._score.toFixed(0)}/100${d.population ? ' · pop ' + fmt(d.population) : ''}</p>
    ${rows}
    <p class="hint" style="margin-top:12px"><b>Amenities mapped (OSM):</b> ${adStr}.<br>
    Nearest int'l school: ${d.metrics.intl_school_name}.<br>
    Internationality / safety / cost are district-level and editable; your numbers save in this browser.</p>`;
  body.querySelectorAll('[data-ov]').forEach(inp => inp.addEventListener('change', e => {
    const key = e.target.dataset.ov, val = e.target.value;
    state.overrides[ags] = state.overrides[ags] || {};
    if (val === '') delete state.overrides[ags][key]; else state.overrides[ags][key] = +val;
    save(); renderWeights(); refresh(); openDetail(ags);
  }));
  document.getElementById('detail').classList.remove('hidden');
}

function refresh() { const vis = compute(); renderTable(vis); styleMap(); }

async function init() {
  DATA = await (await fetch('data/towns.json')).json();
  towns = DATA.towns;
  renderWeights(); renderPolitics(); renderAnchors();

  map = L.map('map', { preferCanvas: true }).setView([DATA.meta.center[0], DATA.meta.center[1]], 9);
  map.attributionControl.addAttribution('© OpenStreetMap · election © Bundeswahlleiterin');
  try {
    const gj = await (await fetch('data/towns.geojson')).json();
    const byAgs = Object.fromEntries(towns.map(d => [d.ags, d]));
    geoLayer = L.geoJSON(gj, {
      style: { weight: 0.6, color: '#0b0d11', fillOpacity: 0.8 },
      onEachFeature: (f, l) => {
        const d = byAgs[f.properties.ags]; l._d = d; if (d) layerByAgs[d.ags] = l;
        l.on('click', () => d && openDetail(d.ags));
        l.bindTooltip(f.properties.name, { sticky: true });
      },
    }).addTo(map);
    map.fitBounds(geoLayer.getBounds(), { padding: [10, 10] });
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
<p>Each criterion's values are normalised 0–100 across the towns currently shown, in the right direction
(closer / more amenities / safer = better). Your weights combine them into one score. Criteria with no data,
or weight 0, are ignored.</p>
<h3>Scope & data</h3>
<p>Towns within ~50&nbsp;km of the SAP St.&nbsp;Leon-Rot / Walldorf campuses — the realistic commuter belt,
including the nearby cities (Heidelberg, Mannheim, Karlsruhe, Speyer, …).</p>
<table><tr><th>Criterion</th><th>Source</th><th>Note</th></tr>
<tr><td>Commute / Heidelberg / Family</td><td>Computed</td><td>Straight-line km from the town centre. Family stays in your browser.</td></tr>
<tr><td>Groceries · Schools & childcare · Health/green/social</td><td>OpenStreetMap</td><td>Counted <em>inside each town's boundary</em> (point-in-polygon). Larger towns naturally score higher.</td></tr>
<tr><td>Int'l / English school</td><td>Curated list</td><td>Distance to nearest of ~34 international schools.</td></tr>
<tr><td>Political fit</td><td>Bundeswahlleiterin 2025</td><td>2nd-vote share by <em>district</em> — one value per district, inherited by its towns.</td></tr>
<tr><td>Internationality · Safety · Cost</td><td>district-level / editable</td><td>Not available per town — inherited from the district and editable; blank until you add data.</td></tr></table>
<p>Boundaries & amenities © OpenStreetMap contributors. Everything is adjustable and saved locally; Export to back up.</p>`;
init();
