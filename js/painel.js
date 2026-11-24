// Painel do PC: mapa + tabela dos pontos, status PlaneView, edição e exportação.
import { applyI18n, bindLangToggle, t } from './i18n.js';
import { $, copyText, download, escapeHtml, formatDate, stamp, toast } from './ui.js';
import { accuracyLevel, formatAccuracy } from './geo.js';
import { formatLatLng, toGeoJSON, toKML } from './export.js';
import { loginWithCode, loginAdmin, dataRepo } from './auth.js';
import { readFarmFile, farmLabel } from './kml.js';

const SESSION_KEY = 'ps-panel-session';
let session = null;
let gh = null;
let points = []; // {...registro, _sha}
let farms = []; // {id, name, geojson, _sha}
let farmLayer;
let selected = new Set();
let activeId = null;
let map;
let layer;
const markers = new Map();
const photoCache = new Map();
let firstFit = true;

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}
function saveSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* ok */ }
}

// ---------- Login ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-err');
  const btn = $('#login-form button');
  const value = $('#code').value.trim();
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = t('login.checking');
  try {
    const s = (await loginWithCode(value)) || (await loginAdmin(value));
    if (!s) {
      err.textContent = t('login.invalid');
      return;
    }
    session = s;
    saveSession(s);
    showApp();
  } finally {
    btn.disabled = false;
    btn.textContent = t('login.submit');
  }
});

$('#logout').addEventListener('click', () => {
  saveSession(null);
  location.reload();
});

function showLogin() {
  $('#app').hidden = true;
  for (const id of ['#refresh', '#logout', '#who', '#admin-link']) $(id).hidden = true;
  $('#login').hidden = false;
  $('#code').focus();
}

function showApp() {
  gh = dataRepo(session.data_token);
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#refresh').hidden = false;
  $('#logout').hidden = false;
  $('#who').hidden = false;
  $('#who').textContent = session.team_label;
  $('#admin-link').hidden = session.role !== 'admin';
  initMap();
  load().then(schedule);
}

function handleError(e) {
  if (e?.status === 401 || e?.status === 403) {
    toast(t('err.auth'), 'error');
    saveSession(null);
    setTimeout(() => location.reload(), 1500);
    return;
  }
  toast(e?.message || String(e), 'error');
}

// ---------- Dados ----------
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

function cacheGet(sha) {
  try {
    return JSON.parse(sessionStorage.getItem('ps-pt-' + sha));
  } catch {
    return null;
  }
}
function cacheSet(sha, data) {
  try {
    sessionStorage.setItem('ps-pt-' + sha, JSON.stringify(data));
  } catch { /* cheio */ }
}

// ---------- Atualização automática ----------
const AUTO_KEY = 'ps-panel-auto';
let lastSig = null;
let lastOk = 0;
let liveState = 'idle'; // ok | error | paused | idle
let loading = false;
let busy = 0; // gravações em andamento
let timer = null;
const newIds = new Map(); // id -> quando chegou
let unseen = 0;
const baseTitle = document.title;

function autoSeconds() {
  return Number($('#auto').value) || 0;
}

function schedule() {
  clearTimeout(timer);
  const secs = autoSeconds();
  if (!secs || !gh) return;
  timer = setTimeout(tick, secs * 1000);
}

async function tick() {
  const dialogOpen = [...document.querySelectorAll('dialog')].some((d) => d.open);
  if (document.visibilityState === 'visible' && !dialogOpen && !busy) await load({ silent: true });
  schedule();
}

function renderLive() {
  const el = $('#live');
  if (!el) return;
  const secs = autoSeconds();
  const state = !secs ? 'paused' : liveState;
  el.className = `live ${state}`;
  const ago = lastOk ? Math.max(0, Math.round((Date.now() - lastOk) / 1000)) : null;
  const agoText = ago == null ? '' : ago < 60 ? t('live.secs', { n: ago }) : t('live.mins', { n: Math.floor(ago / 60) });
  $('#live-text').textContent =
    state === 'error' ? t('live.error') : state === 'paused' ? `${t('live.paused')}${agoText ? ' · ' + agoText : ''}` : `${t('live.on')}${agoText ? ' · ' + agoText : ''}`;
}
setInterval(renderLive, 1000);

function setUnseen(n) {
  unseen = n;
  document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
}
addEventListener('focus', () => setUnseen(0));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && gh && autoSeconds()) {
    clearTimeout(timer);
    tick();
  }
});

async function load({ silent = false } = {}) {
  if (loading) return;
  loading = true;
  if (!silent) $('#rows').innerHTML = `<tr><td class="empty" colspan="8">${escapeHtml(t('panel.loading'))}</td></tr>`;
  try {
    const [pointDir, farmDir] = await Promise.all([gh.listDir('points'), gh.listDir('farms')]);
    const entries = pointDir.filter((e) => e.type === 'file' && e.name.endsWith('.json'));
    const farmEntries = farmDir.filter((e) => e.type === 'file' && e.name.endsWith('.json'));
    lastOk = Date.now();
    liveState = 'ok';
    const sig = [...entries, ...farmEntries].map((e) => e.sha).sort().join(',');
    if (sig === lastSig) {
      renderLive();
      return;
    }
    const firstLoad = lastSig === null;
    lastSig = sig;
    const before = new Set(points.map((p) => p.id));
    farms = (
      await mapLimit(farmEntries, 4, async (e) => {
        const f = await gh.getFile(e.path);
        return f ? { ...JSON.parse(f.text), _sha: e.sha } : null;
      })
    ).filter(Boolean);
    renderFarms();
    const loaded = await mapLimit(entries, 6, async (e) => {
      let data = cacheGet(e.sha);
      if (!data) {
        const f = await gh.getFile(e.path);
        if (!f) return null;
        data = JSON.parse(f.text);
        cacheSet(e.sha, data);
      }
      return { ...data, _sha: e.sha };
    });
    points = loaded.filter(Boolean).sort((a, b) => (b.captured_at || '').localeCompare(a.captured_at || ''));
    selected = new Set([...selected].filter((id) => points.some((p) => p.id === id)));
    if (!firstLoad) {
      const arrived = points.filter((p) => !before.has(p.id));
      for (const p of arrived) newIds.set(p.id, Date.now());
      if (arrived.length) {
        toast(arrived.length === 1 ? t('live.newOne', { name: arrived[0].name }) : t('live.newMany', { n: arrived.length }));
        if (document.visibilityState !== 'visible' || !document.hasFocus()) setUnseen(unseen + arrived.length);
      }
    }
    render();
  } catch (e) {
    if (e?.status === 401 || e?.status === 403 || !silent) {
      if (!silent) $('#rows').innerHTML = '';
      handleError(e);
    }
    liveState = 'error';
  } finally {
    loading = false;
    renderLive();
  }
}

// Destaque de "novo" some depois de 2 minutos.
setInterval(() => {
  let changed = false;
  for (const [id, at] of newIds) {
    if (Date.now() - at > 120000) {
      newIds.delete(id);
      changed = true;
    }
  }
  if (changed) render();
}, 10000);

async function savePoint(p) {
  const { _sha, ...rec } = p;
  rec.updated_at = new Date().toISOString();
  const sha = await gh.putJSON(`points/${p.id}.json`, rec, `Atualiza ${rec.name}`, _sha);
  Object.assign(p, rec, { _sha: sha });
  cacheSet(sha, rec);
  render();
}

// ---------- Mapa ----------
function initMap() {
  if (map || !window.L) return;
  map = L.map('map', { zoomControl: true }).setView([-15.8, -47.9], 4);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Imagens © Esri, Maxar, Earthstar Geographics',
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
  }).addTo(map);
  farmLayer = L.layerGroup().addTo(map);
  layer = L.layerGroup().addTo(map);
}

function popupHtml(p) {
  return `<strong>${escapeHtml(p.name)}</strong><br>
    <span class="mono copyable" data-act="copy" data-id="${escapeHtml(p.id)}" title="${escapeHtml(t('act.clickCopy'))}">${formatLatLng(p.lat, p.lng)}</span><br>
    ${farmOf(p) ? `${escapeHtml(farmOf(p))}<br>` : ''}
    ${formatAccuracy(p.accuracy_m)} · ${escapeHtml(formatDate(p.captured_at))}<br>
    ${escapeHtml(p.team_label || '')} · ${escapeHtml(t('status.' + (p.status || 'pendente')))}
    <div class="row">
      ${p.photo ? `<button class="btn small" data-act="photo" data-id="${escapeHtml(p.id)}" type="button">${escapeHtml(t('panel.photo'))}</button>` : ''}
    </div>`;
}

function renderMap(list) {
  if (!map) return;
  layer.clearLayers();
  markers.clear();
  for (const p of list) {
    const done = p.status === 'lancado';
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 9,
      weight: 3,
      color: '#ffffff',
      fillColor: done ? '#16a34a' : '#f59e0b',
      fillOpacity: 1,
      className: newIds.has(p.id) ? 'marker-new' : '',
    })
      .bindTooltip(p.name, { direction: 'top', offset: [0, -8] })
      .bindPopup(() => popupHtml(p))
      .on('click', () => setActive(p.id, false))
      .addTo(layer);
    if (p.accuracy_m) L.circle([p.lat, p.lng], { radius: p.accuracy_m, weight: 1, color: '#ffffff', fillOpacity: 0.08, interactive: false }).addTo(layer);
    markers.set(p.id, m);
  }
  if (firstFit && (list.length || farms.length)) {
    const b = L.latLngBounds(list.map((p) => [p.lat, p.lng]));
    if (farmLayer.getLayers().length) b.extend(L.featureGroup(farmLayer.getLayers()).getBounds());
    if (b.isValid()) map.fitBounds(b.pad(0.15), { maxZoom: 16 });
    firstFit = false;
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.leaflet-popup [data-act]');
  if (btn) rowAction(btn.dataset.act, btn.dataset.id);
});

// ---------- Tabela ----------
function filtered() {
  const f = $('#filter').value;
  const q = $('#search').value.trim().toLowerCase();
  return points.filter(
    (p) => (f === 'all' || (p.status || 'pendente') === f) && (!q || (p.name || '').toLowerCase().includes(q)),
  );
}

function render() {
  const list = filtered();
  const sel = selected.size ? ` · ${selected.size} ${t('panel.selected')}` : '';
  $('#count').textContent = `${list.length} ${t('panel.count')}${sel}`;
  $('#select-all').checked = list.length > 0 && list.every((p) => selected.has(p.id));
  renderMap(list);
  if (!list.length) {
    $('#rows').innerHTML = `<tr><td class="empty" colspan="8">${escapeHtml(t('panel.empty'))}</td></tr>`;
    return;
  }
  $('#rows').innerHTML = list
    .map((p) => {
      const done = p.status === 'lancado';
      return `<tr data-id="${escapeHtml(p.id)}" class="${p.id === activeId ? 'active' : ''} ${newIds.has(p.id) ? 'is-new' : ''}">
        <td><input type="checkbox" data-act="select" ${selected.has(p.id) ? 'checked' : ''} aria-label="Selecionar"></td>
        <td><strong>${escapeHtml(p.name)}</strong>${p.photo ? ' 📷' : ''}${newIds.has(p.id) ? ` <span class="badge info">${escapeHtml(t('live.newTag'))}</span>` : ''}</td>
        <td class="mono copyable" data-act="copy" title="${escapeHtml(t('act.clickCopy'))}">${formatLatLng(p.lat, p.lng)}</td>
        <td>${escapeHtml(farmOf(p))}</td>
        <td><span class="badge ${accuracyLevel(p.accuracy_m)}">${formatAccuracy(p.accuracy_m)}</span></td>
        <td>${escapeHtml(formatDate(p.captured_at))}<div class="muted small-text">${escapeHtml(p.team_label || '')}</div></td>
        <td><span class="badge ${done ? 'good' : 'ok'}">${escapeHtml(t('status.' + (done ? 'lancado' : 'pendente')))}</span></td>
        <td><div class="actions">
          <button class="btn small" data-act="toggle" type="button" title="${escapeHtml(t(done ? 'panel.markPending' : 'panel.markDone'))}">${escapeHtml(t(done ? 'panel.undoShort' : 'panel.doneShort'))}</button>
          ${p.photo ? `<button class="btn small" data-act="photo" type="button">${escapeHtml(t('panel.photo'))}</button>` : ''}
          <button class="btn small" data-act="edit" type="button">${escapeHtml(t('panel.edit'))}</button>
          <button class="btn-danger small" data-act="delete" type="button">${escapeHtml(t('panel.delete'))}</button>
        </div></td>
      </tr>`;
    })
    .join('');
}

function setActive(id, pan = true) {
  activeId = id;
  document.querySelectorAll('#rows tr').forEach((tr) => tr.classList.toggle('active', tr.dataset.id === id));
  const m = markers.get(id);
  if (m && pan) {
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
    m.openPopup();
  }
  if (!pan) document.querySelector(`#rows tr[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

$('#rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  const el = e.target.closest('[data-act]');
  if (el?.dataset.act === 'select') {
    if (el.checked) selected.add(id);
    else selected.delete(id);
    render();
    return;
  }
  if (newIds.delete(id)) tr.classList.remove('is-new');
  if (el) rowAction(el.dataset.act, id);
  else setActive(id);
});

$('#select-all').addEventListener('change', (e) => {
  for (const p of filtered()) e.target.checked ? selected.add(p.id) : selected.delete(p.id);
  render();
});
$('#filter').addEventListener('change', render);
$('#search').addEventListener('input', render);
$('#refresh').addEventListener('click', () => load({ silent: true }));
try {
  $('#auto').value = localStorage.getItem(AUTO_KEY) ?? '15';
} catch { /* ok */ }
$('#auto').addEventListener('change', () => {
  try {
    localStorage.setItem(AUTO_KEY, $('#auto').value);
  } catch { /* ok */ }
  renderLive();
  if (autoSeconds()) tick();
  else clearTimeout(timer);
});

async function rowAction(act, id) {
  const p = points.find((x) => x.id === id);
  if (!p) return;
  busy++;
  try {
    if (act === 'copy') {
      const coord = formatLatLng(p.lat, p.lng);
      if (await copyText(coord)) toast(`${t('act.copied')} ${coord}`);
    } else if (act === 'toggle') {
      p.status = p.status === 'lancado' ? 'pendente' : 'lancado';
      await savePoint(p);
      toast(t('panel.saved'));
    } else if (act === 'edit') {
      openEdit(p);
    } else if (act === 'photo') {
      await showPhoto(p);
    } else if (act === 'delete') {
      if (!confirm(t('panel.deleteConfirm', { name: p.name }))) return;
      await gh.deleteFile(`points/${p.id}.json`, p._sha, `Apaga ${p.name}`);
      if (p.photo) {
        try {
          const meta = await gh.req('GET', gh.contentsPath(p.photo));
          await gh.deleteFile(p.photo, meta.sha, `Apaga foto ${p.name}`);
        } catch (e) {
          if (e.status !== 404) console.warn(e);
        }
      }
      points = points.filter((x) => x.id !== id);
      selected.delete(id);
      render();
      toast(t('panel.deleted'));
    }
  } catch (e) {
    handleError(e);
  } finally {
    busy--;
  }
}

// ---------- Editar ----------
let editing = null;
function openEdit(p) {
  editing = p;
  $('#edit-name').value = p.name;
  $('#edit-lat').value = p.lat;
  $('#edit-lng').value = p.lng;
  $('#edit-err').textContent = '';
  $('#edit-dialog').showModal();
}
$('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#edit-name').value.trim();
  const lat = Number($('#edit-lat').value.replace(',', '.'));
  const lng = Number($('#edit-lng').value.replace(',', '.'));
  if (!name) {
    $('#edit-err').textContent = t('save.nameRequired');
    return;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    $('#edit-err').textContent = t('panel.invalidCoord');
    return;
  }
  try {
    Object.assign(editing, { name, lat, lng });
    await savePoint(editing);
    $('#edit-dialog').close();
    toast(t('panel.saved'));
  } catch (err) {
    handleError(err);
  }
});

// ---------- Foto ----------
async function showPhoto(p) {
  let url = photoCache.get(p.photo);
  if (!url) {
    url = URL.createObjectURL(await gh.getRawBlob(p.photo));
    photoCache.set(p.photo, url);
  }
  $('#photo-img').src = url;
  $('#photo-img').alt = p.name;
  $('#photo-dialog').showModal();
}
$('#photo-close').addEventListener('click', () => $('#photo-dialog').close());

// ---------- Exportar ----------
function exportList() {
  const list = selected.size ? points.filter((p) => selected.has(p.id)) : filtered();
  return list.map((p) => ({ ...p, farm: farmOf(p) || null }));
}
$('#export-kml').addEventListener('click', () => {
  download(`pivot-scout-${stamp()}.kml`, toKML(exportList()), 'application/vnd.google-earth.kml+xml');
});
$('#export-geo').addEventListener('click', () => {
  download(`pivot-scout-${stamp()}.geojson`, JSON.stringify(toGeoJSON(exportList()), null, 2), 'application/geo+json');
});

// ---------- Fazendas (KML) ----------
const farmCache = new Map();
function farmOf(p) {
  const key = `${p.lat},${p.lng}`;
  if (!farmCache.has(key)) farmCache.set(key, farmLabel(p.lat, p.lng, farms));
  return farmCache.get(key);
}

function renderFarms() {
  farmCache.clear();
  $('#farms-count').textContent = farms.length;
  if (map) {
    farmLayer.clearLayers();
    for (const farm of farms) {
      L.geoJSON(farm.geojson, {
        style: { color: '#facc15', weight: 2, fillColor: '#facc15', fillOpacity: 0.08 },
        pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 4, color: '#facc15', weight: 2 }),
        onEachFeature: (f, l) => {
          const part = f.properties?.name;
          l.bindTooltip(part && part !== farm.name ? `${farm.name} · ${part}` : farm.name, { sticky: true });
        },
      }).addTo(farmLayer);
    }
  }
  const ul = $('#farm-list');
  ul.innerHTML = farms.length
    ? farms
        .map(
          (f) => `<li data-id="${escapeHtml(f.id)}">
        <div class="title"><span>${escapeHtml(f.name)}</span><span class="badge info">${f.geojson.features.length} ${escapeHtml(t('farm.areas'))}</span></div>
        <div class="meta">${escapeHtml(f.file || '')} · ${escapeHtml(formatDate(f.imported_at))}</div>
        <div class="row">
          <button class="btn small" data-act="zoom" type="button">${escapeHtml(t('farm.zoom'))}</button>
          <button class="btn-danger small" data-act="remove" type="button">${escapeHtml(t('farm.remove'))}</button>
        </div></li>`,
        )
        .join('')
    : `<li class="muted">${escapeHtml(t('farm.empty'))}</li>`;
}

$('#farms-btn').addEventListener('click', () => {
  $('#farm-err').textContent = '';
  $('#farm-dialog').showModal();
});
$('#farm-close').addEventListener('click', () => $('#farm-dialog').close());
$('#farm-import').addEventListener('click', () => $('#farm-file').click());

$('#farm-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const err = $('#farm-err');
  const btn = $('#farm-import');
  err.textContent = '';
  try {
    const { name: docName, geojson } = await readFarmFile(file);
    const suggested = docName || file.name.replace(/\.(kml|kmz)$/i, '');
    const name = prompt(t('farm.namePrompt'), suggested)?.trim();
    if (!name) return;
    btn.disabled = true;
    btn.textContent = t('farm.saving');
    const id = `${stamp()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
    const rec = { id, name, file: file.name, imported_at: new Date().toISOString(), team_label: session.team_label, geojson };
    const sha = await gh.putJSON(`farms/${id}.json`, rec, `Importa fazenda ${name}`);
    farms.push({ ...rec, _sha: sha });
    renderFarms();
    render();
    if (map) map.fitBounds(L.geoJSON(geojson).getBounds().pad(0.1));
    toast(t('farm.imported'));
  } catch (e2) {
    if (e2.status) handleError(e2);
    else err.textContent = e2.message || String(e2);
  } finally {
    btn.disabled = false;
    btn.textContent = t('farm.import');
  }
});

$('#farm-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const farm = farms.find((f) => f.id === btn.closest('li').dataset.id);
  if (!farm) return;
  if (btn.dataset.act === 'zoom') {
    $('#farm-dialog').close();
    map?.fitBounds(L.geoJSON(farm.geojson).getBounds().pad(0.1));
  } else if (btn.dataset.act === 'remove') {
    if (!confirm(t('farm.removeConfirm', { name: farm.name }))) return;
    try {
      await gh.deleteFile(`farms/${farm.id}.json`, farm._sha, `Remove fazenda ${farm.name}`);
      farms = farms.filter((f) => f !== farm);
      renderFarms();
      render();
    } catch (e2) {
      handleError(e2);
    }
  }
});

// ---------- Início ----------
applyI18n();
bindLangToggle($('#lang'), () => {
  if (session) {
    $('#who').textContent = session.team_label;
    render();
  }
});
session = loadSession();
if (session?.data_token) showApp();
else showLogin();
