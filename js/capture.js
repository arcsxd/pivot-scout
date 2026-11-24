// Tela do celular: captura da ponta externa do pivot.
import { applyI18n, bindLangToggle, t } from './i18n.js';
import { $, compressImage, copyText, escapeHtml, formatDate, registerSW, toast } from './ui.js';
import { watchPosition, accuracyLevel, formatAccuracy } from './geo.js';
import { formatLatLng } from './export.js';
import { kvGet, kvSet, kvDel, putPoint, getPoints, deletePoint } from './store.js';
import { loginWithCode, dataRepo } from './auth.js';
import { syncPending } from './sync.js';

let session = null;
let current = null; // última leitura do GPS
let frozen = null; // leitura congelada no botão Capturar
let photoBlob = null;
let stopWatch = null;
let gpsMsg = '';

// ---------- Rede ----------
function renderNet() {
  const el = $('#net');
  const on = navigator.onLine;
  el.textContent = on ? t('app.online') : t('app.offline');
  el.className = `pill ${on ? 'on' : 'off'}`;
}
addEventListener('online', () => {
  renderNet();
  trySync();
});
addEventListener('offline', renderNet);

// ---------- Login ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-err');
  const btn = e.submitter || $('#login-form button');
  if (!navigator.onLine) {
    err.textContent = t('login.needNet');
    return;
  }
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = t('login.checking');
  try {
    const s = await loginWithCode($('#code').value);
    if (!s) {
      err.textContent = t('login.invalid');
      return;
    }
    session = s;
    await kvSet('session', s);
    showApp();
  } finally {
    btn.disabled = false;
    btn.textContent = t('login.submit');
  }
});

$('#logout').addEventListener('click', async () => {
  const pending = (await getPoints()).filter((p) => !p.synced).length;
  if (pending && !confirm(t('act.logoutPending'))) return;
  await kvDel('session');
  stopWatch?.();
  session = null;
  showLogin();
});

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#code').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#team-label').textContent = session.team_label;
  startGPS();
  renderList();
  trySync();
}

// ---------- GPS ----------
function startGPS() {
  stopWatch?.();
  gpsMsg = t('gps.waiting');
  renderGPS();
  stopWatch = watchPosition(
    (pos) => {
      current = pos;
      gpsMsg = '';
      renderGPS();
    },
    (err) => {
      if (err.code === 1) gpsMsg = t('gps.denied');
      else if (err.code === 3) gpsMsg = current ? '' : t('gps.waiting');
      else gpsMsg = t('gps.error') + (err.message || err.code);
      renderGPS();
    },
  );
}

function setAccBadge(el, acc) {
  el.textContent = formatAccuracy(acc);
  el.className = `badge ${accuracyLevel(acc)}`;
}

function renderGPS() {
  if (current) {
    $('#lat').textContent = current.lat.toFixed(6);
    $('#lng').textContent = current.lng.toFixed(6);
    setAccBadge($('#acc'), current.accuracy);
  }
  const time = current ? t('gps.updated') + new Date(current.timestamp).toLocaleTimeString() : '';
  $('#gps-status').textContent = gpsMsg || time;
  $('#capture').disabled = !current;
}

// Tocar na posição atual copia "lat, long".
$('#coords').addEventListener('click', async () => {
  if (!current) return;
  const coord = formatLatLng(current.lat, current.lng);
  if (await copyText(coord)) toast(`${t('act.copied')} ${coord}`);
});

$('#capture').addEventListener('click', () => {
  if (!current) return;
  frozen = { ...current };
  $('#cap-coord').textContent = formatLatLng(frozen.lat, frozen.lng);
  setAccBadge($('#cap-acc'), frozen.accuracy);
  $('#save-form').hidden = false;
  $('#name-err').textContent = '';
  $('#save-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('#name').focus(), 300);
});

// ---------- Foto ----------
$('#photo-btn').addEventListener('click', () => $('#photo').click());
$('#photo').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    photoBlob = await compressImage(file);
  } catch {
    photoBlob = file;
  }
  const img = $('#photo-preview');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(photoBlob);
  img.hidden = false;
  $('#photo-remove').hidden = false;
});
$('#photo-remove').addEventListener('click', clearPhoto);

function clearPhoto() {
  photoBlob = null;
  $('#photo').value = '';
  const img = $('#photo-preview');
  if (img.src) URL.revokeObjectURL(img.src);
  img.removeAttribute('src');
  img.hidden = true;
  $('#photo-remove').hidden = true;
}

function resetForm() {
  frozen = null;
  $('#name').value = '';
  clearPhoto();
  $('#save-form').hidden = true;
}

$('#discard').addEventListener('click', resetForm);
$('#name').addEventListener('input', () => ($('#name-err').textContent = ''));

// ---------- Salvar ----------
function newId(date) {
  const p = (n) => String(n).padStart(2, '0');
  const d = date;
  const rnd = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).padStart(6, '0').slice(0, 6);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`;
}

$('#save-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#name').value.trim();
  if (!name) {
    $('#name-err').textContent = t('save.nameRequired');
    $('#name').focus();
    return;
  }
  if (!frozen) return;
  const when = new Date(frozen.timestamp);
  const point = {
    id: newId(when),
    name,
    lat: Number(frozen.lat.toFixed(7)),
    lng: Number(frozen.lng.toFixed(7)),
    accuracy_m: Math.round(frozen.accuracy * 10) / 10,
    altitude_m: frozen.altitude != null ? Math.round(frozen.altitude * 10) / 10 : null,
    captured_at: when.toISOString(),
    team_id: session.team_id,
    team_label: session.team_label,
    photoBlob: photoBlob || null,
    photo_uploaded: false,
    synced: false,
  };
  await putPoint(point);
  resetForm();
  toast(t('save.saved'));
  await renderList();
  trySync();
});

// ---------- Lista ----------
async function renderList() {
  const points = (await getPoints()).sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  const pending = points.filter((p) => !p.synced).length;
  $('#pending-count').textContent = pending;
  const ul = $('#points');
  if (!points.length) {
    ul.innerHTML = `<li class="muted">${escapeHtml(t('list.empty'))}</li>`;
    return;
  }
  ul.innerHTML = points
    .map((p) => {
      const coord = formatLatLng(p.lat, p.lng);
      const st = p.synced
        ? `<span class="badge good">✓ ${escapeHtml(t('list.synced'))}</span>`
        : `<span class="badge ok">⏳ ${escapeHtml(t('list.pendingOne'))}</span>`;
      return `<li data-id="${escapeHtml(p.id)}">
        <div class="title"><span>${escapeHtml(p.name)}</span>${st}</div>
        <div><span class="mono copyable" data-act="copy" role="button" tabindex="0">${coord}</span></div>
        <div class="meta"><span class="badge ${accuracyLevel(p.accuracy_m)}">${formatAccuracy(p.accuracy_m)}</span>
          <span>${escapeHtml(formatDate(p.captured_at))}</span>${p.photoBlob ? '<span>📷</span>' : ''}</div>
        <div class="row">
          ${navigator.share ? `<button class="btn small" data-act="share" type="button">${escapeHtml(t('act.share'))}</button>` : ''}
          <button class="btn-danger small" data-act="remove" type="button">${escapeHtml(t('act.remove'))}</button>
        </div>
      </li>`;
    })
    .join('');
}

$('#points').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const p = (await getPoints()).find((x) => x.id === id);
  if (!p) return;
  const coord = formatLatLng(p.lat, p.lng);
  if (btn.dataset.act === 'copy') {
    if (await copyText(coord)) toast(`${t('act.copied')} ${coord}`);
  } else if (btn.dataset.act === 'share') {
    const text = `${p.name}\n${coord}\n${formatAccuracy(p.accuracy_m)}\nhttps://maps.google.com/?q=${p.lat},${p.lng}`;
    navigator.share({ title: p.name, text }).catch(() => {});
  } else if (btn.dataset.act === 'remove') {
    if (!confirm(p.synced ? t('list.removeConfirm') : t('list.removePendingConfirm'))) return;
    await deletePoint(id);
    renderList();
  }
});

// ---------- Sincronização ----------
async function trySync(manual = false) {
  if (!session) return;
  const msg = $('#sync-msg');
  const pending = (await getPoints()).filter((p) => !p.synced).length;
  if (!pending) {
    if (manual) msg.textContent = t('sync.done');
    return;
  }
  if (!navigator.onLine) {
    msg.textContent = t('sync.waitNet');
    return;
  }
  msg.textContent = t('sync.sending');
  const res = await syncPending(dataRepo(session.data_token), renderList);
  if (res.skipped) return;
  await renderList();
  if (res.lastError) {
    const s = res.lastError.status;
    if (s === 401 || s === 403 || s === 404) {
      // Código revogado ou token trocado: os pontos continuam no celular
      // e são enviados assim que o operador entrar com um código novo.
      await kvDel('session');
      session = null;
      stopWatch?.();
      showLogin();
      $('#login-err').textContent = t('sync.auth');
      return;
    }
    msg.textContent = t('sync.error') + res.lastError.message;
  } else {
    msg.textContent = t('sync.sent') + res.sent;
  }
}

$('#sync-now').addEventListener('click', () => trySync(true));
setInterval(() => trySync(), 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') trySync();
});

// ---------- Início ----------
applyI18n();
bindLangToggle($('#lang'), () => {
  renderNet();
  renderGPS();
  renderList();
});
renderNet();
registerSW();
session = (await kvGet('session')) || null;
if (session) showApp();
else showLogin();
