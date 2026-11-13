/* Where to live — commuter-belt TOWN dashboard
   Vanilla JS. Data: data/towns.json + data/towns.geojson. Settings: localStorage. */
'use strict';
const LS_KEY = 'reloc.towns.v1';

/* ---- colour ramp (rank-based, refined dark) ---- */
const RAMP = [[54, 66, 110], [60, 110, 180], [40, 160, 176], [70, 190, 120], [190, 230, 90]];
function ramp(t) {
  if (t == null) return '#272c37';
  t = Math.max(0, Math.min(1, t));
  const s = t * (RAMP.length - 1), i = Math.floor(s), f = s - i;
  const a = RAMP[i], b = RAMP[Math.min(i + 1, RAMP.length - 1)];
  const c = k => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

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

const GROUPS = [
  { id: 'location', label: 'Location & distances', icon: '📍' },
  { id: 'daily', label: 'Daily life', icon: '🛒', note: 'counted in the town · OpenStreetMap' },
  { id: 'community', label: 'Community & costs', icon: '🏛️', note: 'district-level · some editable' },
];
const CRITERIA = [
  { id: 'work', group: 'location', label: 'Commute to work', dir: 'low', unit: 'km', dist: true,
    value: d => avg(d.metrics.dist_work_rot, d.metrics.dist_work_wdf),
    help: 'Straight-line km (avg of SAP ROT + WDF).' },
  { id: 'heidelberg', group: 'location', label: 'Near Heidelberg', dir: 'low', unit: 'km', dist: true,
    value: d => d.metrics.dist_heidelberg, help: 'Straight-line km to Heidelberg.' },
  { id: 'family', group: 'location', label: 'Near family', dir: 'low', unit: 'km', dist: true, needs: 'set a family anchor',
    value: d => state.family ? haversine(d.lat, d.lon, state.family.lat, state.family.lon) : null,
    help: 'Straight-line km to the family location you set below.' },
  { id: 'intl_school', group: 'location', label: "Int'l / English school", dir: 'low', unit: 'km',
    value: d => d.metrics.intl_school_km, help: 'Distance to nearest international / English-medium school.' },
  { id: 'groceries', group: 'daily', label: 'Groceries & daily shops', dir: 'high', unit: '', amen: true,
    value: d => gm(d, 'groceries'), help: 'Supermarkets, bakeries, butchers, etc.' },
  { id: 'schools_childcare', group: 'daily', label: 'Schools & childcare', dir: 'high', unit: '', amen: true,
    value: d => gm(d, 'schools_childcare'), help: 'Schools + Kitas.' },
  { id: 'health_social_green', group: 'daily', label: 'Health, green & social', dir: 'high', unit: '', amen: true,
    value: d => gm(d, 'health_social_green'), help: 'Doctors, pharmacies, parks, restaurants/cafés.' },
  { id: 'politics', group: 'community', label: 'Political fit', dir: 'high', unit: '%', needs: 'pick a party below',
    value: d => state.politicsTarget ? (d.metrics.politics[state.politicsTarget] ?? null) : null,
    help: '2025 Bundestag 2nd-vote share of your party (by district).' },
  { id: 'international', group: 'community', label: 'Internationality', dir: 'high', unit: '%', ovkey: 'foreign_share',
    value: d => gm(d, 'foreign_share'), help: 'Foreign-population share (district-level). Editable.' },
  { id: 'safety', group: 'community', label: 'Safety (low crime)', dir: 'low', unit: '/100k', ovkey: 'crime_per100k',
    value: d => gm(d, 'crime_per100k'), help: 'Crime frequency (district-level). Editable.' },
  { id: 'cost', group: 'community', label: 'Low cost (land price)', dir: 'low', unit: '€/m²', ovkey: 'landprice_eur_m2',
    value: d => gm(d, 'landprice_eur_m2'), help: 'Building-land price proxy (district-level). Editable.' },
];
const CRIT = Object.fromEntries(CRITERIA.map(c => [c.id, c]));
const DEFAULTS = { work: 8, heidelberg: 5, family: 5, intl_school: 3, groceries: 4,
  schools_childcare: 4, health_social_green: 3, politics: 0, international: 2, safety: 4, cost: 4 };

let DATA = null, towns = [], map = null, geoLayer = null, anchorLayer = null;
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
    hintSeen: s.hintSeen || false,
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
  const T = (c, v) => c.amen ? Math.log1p(v) : v;
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
  // rank-based colour: spread the full gradient across the visible towns
  const scored = towns.filter(d => d._visible && d._score != null).sort((a, b) => a._score - b._score);
  scored.forEach((d, i) => d._ct = scored.length < 2 ? 1 : i / (scored.length - 1));
  towns.forEach(d => { if (!d._visible || d._score == null) d._ct = null; });

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
const fmt = (v, dp = 0) => v == null ? '—' : (+v).toLocaleString('en', { maximumFractionDigits: dp });

function renderWeights() {
  const host = document.getElementById('weights'); host.innerHTML = '';
  for (const g of GROUPS) {
    const sec = document.createElement('div'); sec.className = 'cgroup';
    sec.innerHTML = `<div class="cgroup-h"><span class="ci">${g.icon}</span><span>${g.label}</span>${g.note ? `<span class="cnote">${g.note}</span>` : ''}</div>`;
    for (const c of CRITERIA.filter(x => x.group === g.id)) {
      const w = state.weights[c.id] || 0;
      const need = c.needs && ((c.id === 'politics' && !state.politicsTarget) || (c.id === 'family' && !state.family))
        ? `<span class="nodata">${c.needs}</span>` : '';
      const nod = c.ovkey && towns.every(d => c.value(d) == null)
        ? `<span class="nodata">no data — add per town</span>` : '';
      const el = document.createElement('div'); el.className = 'crit' + (w ? '' : ' off');
      el.innerHTML = `<div class="top"><span class="nm">${c.label}</span><span class="wt">${w}</span></div>
        <input type="range" min="0" max="10" step="1" value="${w}" data-w="${c.id}" aria-label="${c.label} weight">
        <div class="meta">${c.help} ${need}${nod}</div>
        ${c.dist ? `<div class="meta flt">max <input type="number" min="0" step="5" placeholder="∞" value="${state.limits[c.id] ?? ''}" data-lim="${c.id}"> km</div>` : ''}`;
      sec.appendChild(el);
    }
    host.appendChild(sec);
  }
  host.querySelectorAll('[data-w]').forEach(r => r.addEventListener('input', e => {
    const id = e.target.dataset.w; state.weights[id] = +e.target.value;
    const crit = e.target.closest('.crit');
    crit.querySelector('.wt').textContent = e.target.value;
    crit.classList.toggle('off', +e.target.value === 0);
    save(); refresh();
  }));
  host.querySelectorAll('[data-lim]').forEach(r => r.addEventListener('input', e => {
    const v = e.target.value; state.limits[e.target.dataset.lim] = v === '' ? '' : +v; save(); refresh();
  }));
}

function renderAnchors() {
  const host = document.getElementById('anchors'); host.innerHTML = '';
  for (const a of Object.values(DATA.meta.anchors))
    host.insertAdjacentHTML('beforeend',
      `<div class="anchor seeded"><span class="dot"></span><span class="lbl">${a.label}</span></div>`);
  const fam = state.family;
  host.insertAdjacentHTML('beforeend', `<div class="anchor fam">
    <div class="lbl"><span class="dot fam"></span>Family ${fam ? `<button class="link" id="famClear">clear</button>` : ''}</div>
    <div class="st" id="famSt">${fam ? `${fam.label} · ${fam.lat.toFixed(3)}, ${fam.lon.toFixed(3)}` : 'not set — stays in this browser'}</div>
    <div class="famrow"><input id="famQ" placeholder="Town or address, e.g. Tübingen"><button id="famGo">Find</button></div>
    <input id="famLL" class="llin" placeholder="…or paste  lat, lon"></div>`);
  document.getElementById('famGo').onclick = geocodeFamily;
  document.getElementById('famQ').addEventListener('keydown', e => { if (e.key === 'Enter') geocodeFamily(); });
  document.getElementById('famLL').addEventListener('change', e => {
    const m = e.target.value.split(/[ ,]+/).map(Number);
    if (m.length === 2 && m.every(n => !isNaN(n))) setFamily({ lat: m[0], lon: m[1], label: 'manual' });
  });
  const clr = document.getElementById('famClear'); if (clr) clr.onclick = () => { state.family = null; save(); renderAnchors(); renderWeights(); renderAnchorMarkers(); refresh(); };
}
async function geocodeFamily() {
  const q = document.getElementById('famQ').value.trim(); if (!q) return;
  const st = document.getElementById('famSt'); st.textContent = 'locating…';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!j.length) { st.textContent = 'not found — try a larger nearby town or paste lat, lon'; return; }
    setFamily({ lat: +j[0].lat, lon: +j[0].lon, label: q });
  } catch (e) { st.textContent = 'lookup failed — paste lat, lon instead'; }
}
function setFamily(f) { state.family = f; save(); renderAnchors(); renderWeights(); renderAnchorMarkers(); refresh(); }

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
    const sc = d._score, col = ramp(d._ct);
    tr.innerHTML = `<td class="rk">${d._rank}</td><td class="tn">${d.name}</td><td class="muted">${d.kreis}</td>
      <td><span class="pill" style="--c:${col}">${sc == null ? '—' : sc.toFixed(0)}</span></td>
      <td>${fmt(CRIT.work.value(d), 1)}</td><td>${fmt(d.metrics.dist_heidelberg, 1)}</td>
      <td>${fmt(CRIT.family.value(d), 1)}</td><td>${fmt(d.metrics.groceries)}</td><td>${fmt(d.metrics.schools_childcare)}</td>`;
    tr.onclick = () => openDetail(d.ags);
    frag.appendChild(tr); rowByAgs[d.ags] = tr;
  }
  tb.appendChild(frag);
  document.querySelectorAll('#table th').forEach(th => {
    const k = th.dataset.sort;
    th.classList.toggle('sorted', state.sort.key === k);
    th.dataset.dir = state.sort.key === k ? state.sort.dir : '';
    th.onclick = () => {
      state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'desc' ? 'asc' : 'desc' };
      save(); refresh();
    };
  });
}

function styleMap() {
  if (!geoLayer) return;
  geoLayer.eachLayer(l => {
    const d = l._d; if (!d) return;
    l.setStyle({ fillColor: ramp(d._ct), fillOpacity: d._visible ? 0.88 : 0.06,
      weight: d._visible ? 0.6 : 0.3, color: '#0b0d11' });
  });
}

function renderAnchorMarkers() {
  if (!map) return;
  if (anchorLayer) anchorLayer.remove();
  anchorLayer = L.layerGroup().addTo(map);
  const pin = (lat, lon, label, cls) => L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html: `<div class="pin ${cls}" title="${label}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
    interactive: true,
  }).bindTooltip(label, { direction: 'top' }).addTo(anchorLayer);
  for (const a of Object.values(DATA.meta.anchors)) pin(a.lat, a.lon, a.label, 'work');
  if (state.family) pin(state.family.lat, state.family.lon, 'Family · ' + state.family.label, 'fam');
}

function openDetail(ags) {
  const d = towns.find(x => x.ags === ags); if (!d) return;
  document.querySelectorAll('tbody tr.sel').forEach(t => t.classList.remove('sel'));
  if (rowByAgs[ags]) { rowByAgs[ags].classList.add('sel'); rowByAgs[ags].scrollIntoView({ block: 'nearest' }); }
  if (layerByAgs[ags]) map.fitBounds(layerByAgs[ags].getBounds(), { maxZoom: 12, padding: [40, 40] });
  const act = activeCriteria();
  const ad = d.metrics.amenity_detail || {};
  const chips = Object.keys(ad).length ? Object.entries(ad).map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('') : '<span class="muted">none mapped</span>';
  const groupRows = g => CRITERIA.filter(c => c.group === g).map(c => {
    const v = c.value(d);
    const n = d._norm && d._norm[c.id];
    const bar = (n != null && act.includes(c)) ? `<span class="nbar"><i style="width:${Math.round(n * 100)}%;--c:${ramp(d._ct)}"></i></span>` : '';
    if (c.ovkey) {
      const ov = (state.overrides[ags] || {})[c.ovkey];
      return `<div class="mrow"><span class="k">${c.label}</span>
        <span class="ed"><input type="number" step="any" placeholder="${v == null ? '—' : v}" value="${ov ?? ''}" data-ov="${c.ovkey}">${c.unit}</span></div>${bar ? `<div class="mbar">${bar}</div>` : ''}`;
    }
    return `<div class="mrow"><span class="k">${c.label}</span><span class="v">${fmt(v, 1)} ${c.unit}</span></div>${bar ? `<div class="mbar">${bar}</div>` : ''}`;
  }).join('');
  const body = document.getElementById('detailBody');
  body.innerHTML = `
    <div class="dhead"><div><h3>${d.name}</h3><p class="sub">${d.kreis} · ${d.state}${d.population ? ' · pop ' + fmt(d.population) : ''}</p></div>
      <span class="ring" style="--c:${ramp(d._ct)}">${d._score == null ? '—' : d._score.toFixed(0)}</span></div>
    <div class="dsec"><h4>📍 Location & distances</h4>${groupRows('location')}</div>
    <div class="dsec"><h4>🛒 Daily life</h4>${groupRows('daily')}
      <div class="chips">${chips}</div></div>
    <div class="dsec"><h4>🏛️ Community & costs</h4>${groupRows('community')}
      <p class="hint">District-level; type values to override — saved in this browser.</p></div>
    <p class="hint">Nearest int'l school: ${d.metrics.intl_school_name}.</p>`;
  body.querySelectorAll('[data-ov]').forEach(inp => inp.addEventListener('change', e => {
    const key = e.target.dataset.ov, val = e.target.value;
    state.overrides[ags] = state.overrides[ags] || {};
    if (val === '') delete state.overrides[ags][key]; else state.overrides[ags][key] = +val;
    save(); renderWeights(); refresh(); openDetail(ags);
  }));
  document.getElementById('detail').classList.add('open');
}

function refresh() { const vis = compute(); renderTable(vis); styleMap(); }

async function init() {
  DATA = await (await fetch('data/towns.json')).json();
  towns = DATA.towns;
  renderWeights(); renderPolitics(); renderAnchors();
  if (!state.hintSeen) document.getElementById('hint').classList.remove('hidden');

  map = L.map('map', { preferCanvas: true, zoomControl: true }).setView([DATA.meta.center[0], DATA.meta.center[1]], 9);
  map.attributionControl.setPrefix('').addAttribution('© OpenStreetMap · election © Bundeswahlleiterin');
  try {
    const gj = await (await fetch('data/towns.geojson')).json();
    const byAgs = Object.fromEntries(towns.map(d => [d.ags, d]));
    geoLayer = L.geoJSON(gj, {
      style: { weight: 0.6, color: '#0b0d11', fillOpacity: 0.85 },
      onEachFeature: (f, l) => {
        const d = byAgs[f.properties.ags]; l._d = d; if (d) layerByAgs[d.ags] = l;
        l.on('click', () => d && openDetail(d.ags));
        l.on('mouseover', () => l.setStyle({ weight: 2, color: '#e8eaed' }));
        l.on('mouseout', () => l.setStyle({ weight: l._d && l._d._visible ? 0.6 : 0.3, color: '#0b0d11' }));
        l.bindTooltip(f.properties.name, { sticky: true });
      },
    }).addTo(map);
    map.fitBounds(geoLayer.getBounds(), { padding: [12, 12] });
  } catch (e) { console.warn('geojson load failed', e); }
  renderAnchorMarkers();

  document.getElementById('detailClose').onclick = () => document.getElementById('detail').classList.remove('open');
  document.getElementById('allOff').onclick = () => { CRITERIA.forEach(c => state.weights[c.id] = 0); save(); renderWeights(); refresh(); };
  document.getElementById('resetBtn').onclick = () => { if (confirm('Reset all weights, filters, anchors and edits?')) { localStorage.removeItem(LS_KEY); state = loadState(); renderWeights(); renderPolitics(); renderAnchors(); renderAnchorMarkers(); refresh(); } };
  document.getElementById('exportBtn').onclick = exportSettings;
  document.getElementById('importFile').addEventListener('change', importSettings);
  document.getElementById('helpBtn').onclick = () => { document.getElementById('helpBody').innerHTML = HELP; document.getElementById('help').classList.add('open'); };
  document.getElementById('helpClose').onclick = () => document.getElementById('help').classList.remove('open');
  document.getElementById('hintClose').onclick = () => { state.hintSeen = true; save(); document.getElementById('hint').classList.add('hidden'); };
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
  rd.onload = () => { try { localStorage.setItem(LS_KEY, rd.result); state = loadState(); renderWeights(); renderPolitics(); renderAnchors(); renderAnchorMarkers(); refresh(); } catch (x) { alert('Invalid settings file'); } };
  rd.readAsText(f);
}
const HELP = `<h2>How scoring works</h2>
<p>Each criterion's values are normalised across the towns currently shown, in the right direction
(closer / more amenities / safer = better). Your weights combine them into one 0–100 score.
Criteria with weight 0 or no data are ignored.</p>
<p><b>Map colour is relative:</b> towns are coloured by their <em>rank</em> in the current view, so the
full gradient always spreads across what's on screen — small real differences stay visible. The number is the absolute score.</p>
<h3>Scope & data</h3>
<p>Towns within ~50&nbsp;km of the SAP St.&nbsp;Leon-Rot / Walldorf campuses — the realistic commuter belt,
including nearby cities (Heidelberg, Mannheim, Karlsruhe, Speyer…).</p>
<table><tr><th>Criterion</th><th>Source</th><th>Note</th></tr>
<tr><td>Commute / Heidelberg / Family</td><td>Computed</td><td>Straight-line km from the town centre. Family stays in your browser.</td></tr>
<tr><td>Groceries · Schools & childcare · Health/green/social</td><td>OpenStreetMap</td><td>Counted inside each town's boundary. Log-scaled so a big city doesn't swamp the rest.</td></tr>
<tr><td>Int'l / English school</td><td>Curated list</td><td>Distance to nearest of ~34 international schools.</td></tr>
<tr><td>Political fit</td><td>Bundeswahlleiterin 2025</td><td>2nd-vote share by district, inherited by its towns.</td></tr>
<tr><td>Internationality · Safety · Cost</td><td>district / editable</td><td>Not available per town — inherited, blank until you add data.</td></tr></table>
<p>Boundaries & amenities © OpenStreetMap contributors. Everything is saved locally; Export to back up or share.</p>`;
init();
