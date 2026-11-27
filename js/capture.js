// Tela do celular: captura da ponta externa do pivot.
import { applyI18n, bindLangToggle, t } from './i18n.js';
import { $, compressImage, copyText, escapeHtml, formatDate, registerSW, toast } from './ui.js';
import { watchPosition, accuracyLevel, formatAccuracy } from './geo.js';
import { formatLatLng } from './export.js';
import { kvGet, kvSet, kvDel, putPoint, getPoints, deletePoint } from './store.js';
import { loginWithCode, dataRepo } from './auth.js';
import { syncPending } from './sync.js';
import { heartbeat, newDeviceId, platform } from './presence.js';
import { isExpired, lifeLeft, formatRemaining } from './expiry.js';

const icon = (name) => `<svg class="i" aria-hidden="true"><use href="icons/sprite.svg#${name}"/></svg>`;
const vibrate = (p) => {
  try {
    navigator.vibrate?.(p);
  } catch { /* sem vibração */ }
};

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
addEventListener('offline', () => {
  renderNet();
  if (session) renderList();
});

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
    s.operator = $('#operator').value.trim();
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
  stopHeartbeat();
  $('#dock').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#code').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#dock').hidden = false;
  $('#team-label').textContent = session.operator ? `${session.team_label} · ${session.operator}` : session.team_label;
  startGPS();
  renderList();
  trySync();
  startHeartbeat();
}

// ---------- Presença (admin vê quem está online) ----------
let deviceId = null;
let hbTimer = null;
let lastCaptureAt = null;

async function sendHeartbeat() {
  if (!session || !navigator.onLine) return;
  deviceId ||= (await kvGet('device_id')) || newDeviceId();
  await kvSet('device_id', deviceId);
  const pending = (await getPoints()).filter((p) => !p.synced).length;
  await heartbeat(dataRepo(session.data_token), {
    device_id: deviceId,
    app: 'captura',
    team_id: session.team_id,
    team_label: session.team_label,
    operator: session.operator || '',
    platform: platform(),
    visible: document.visibilityState === 'visible',
    pending,
    gps: current ? { lat: current.lat, lng: current.lng, accuracy: Math.round(current.accuracy * 10) / 10 } : null,
    last_capture_at: lastCaptureAt,
  });
}

function startHeartbeat() {
  stopHeartbeat();
  sendHeartbeat();
  hbTimer = setInterval(() => {
    if (document.visibilityState === 'visible') sendHeartbeat();
  }, 60000);
}

function stopHeartbeat() {
  clearInterval(hbTimer);
  hbTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (hbTimer) sendHeartbeat(); // avisa quando sai ou volta para o app
});

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

// Medidor redondo: arco cheio = precisão ótima. Escala logarítmica de 1 m a 30 m.
const ARC = 2 * Math.PI * 52;
let lastTs = 0;
function renderGauge() {
  const g = $('#acc');
  const arc = g.querySelector('.gauge-arc');
  const acc = current?.accuracy;
  const level = current ? accuracyLevel(acc) : gpsMsg && gpsMsg !== t('gps.waiting') ? 'error' : 'none';
  g.className = `gauge ${level}`;
  if (!current) {
    $('#acc-num').textContent = '—';
    $('#acc-level').textContent = level === 'error' ? t('gps.noSignal') : t('gps.searching');
    arc.style.strokeDashoffset = ARC;
    g.setAttribute('aria-valuenow', 0);
    return;
  }
  const frac = Math.min(1, Math.max(0.04, Math.log(30 / Math.max(acc, 1)) / Math.log(30)));
  arc.style.strokeDasharray = ARC;
  arc.style.strokeDashoffset = ARC * (1 - frac);
  $('#acc-num').textContent = acc < 10 ? acc.toFixed(1) : Math.round(acc);
  $('#acc-level').textContent = t(`gps.level.${level}`);
  g.setAttribute('aria-valuenow', Math.round(frac * 100));
  g.setAttribute('aria-valuetext', `${formatAccuracy(acc)} · ${t(`gps.level.${level}`)}`);
  // Pulso a cada leitura nova do GPS.
  if (current.timestamp !== lastTs) {
    lastTs = current.timestamp;
    g.classList.remove('pulse');
    void g.offsetWidth;
    g.classList.add('pulse');
  }
}

function renderGPS() {
  if (current) {
    $('#lat').textContent = current.lat.toFixed(6);
    $('#lng').textContent = current.lng.toFixed(6);
  }
  renderGauge();
  const time = current ? new Date(current.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  $('#gps-status').textContent = gpsMsg || time;
  $('#capture').disabled = !current;
  $('#capture').classList.toggle('ready', !!current && accuracyLevel(current.accuracy) === 'good');
}

// Tocar na posição atual copia "lat, long".
$('#coords').addEventListener('click', async () => {
  if (!current) return;
  const coord = formatLatLng(current.lat, current.lng);
  if (await copyText(coord)) {
    flashCopied($('#coords'));
    toast(`${t('act.copied')} ${coord}`);
  }
});

function flashCopied(el) {
  el.classList.remove('copied');
  void el.offsetWidth;
  el.classList.add('copied');
  vibrate(12);
}

$('#capture').addEventListener('click', () => {
  if (!current) return;
  frozen = { ...current };
  $('#cap-coord').textContent = formatLatLng(frozen.lat, frozen.lng);
  setAccBadge($('#cap-acc'), frozen.accuracy);
  $('#name-err').textContent = '';
  // "Obturador": flash na tela, onda no botão e vibração curta.
  const btn = $('#capture');
  btn.classList.remove('fired');
  void btn.offsetWidth;
  btn.classList.add('fired');
  const flash = $('#flash');
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
  vibrate(30);
  setTimeout(() => {
    $('#sheet').showModal();
    $('#name').focus();
  }, 160);
});

function closeSheet() {
  const sheet = $('#sheet');
  if (!sheet.open) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return sheet.close();
  sheet.classList.add('closing');
  setTimeout(() => {
    sheet.classList.remove('closing');
    sheet.close();
  }, 250);
}
$('#sheet').addEventListener('cancel', (e) => {
  e.preventDefault();
  resetForm();
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
  closeSheet();
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
    operator: session.operator || '',
    photoBlob: photoBlob || null,
    photo_uploaded: false,
    synced: false,
  };
  await putPoint(point);
  lastCaptureAt = point.captured_at;
  resetForm();
  showSuccess(t('save.saved'));
  vibrate([20, 40, 20]);
  freshId = point.id;
  await renderList();
  trySync();
});

function showSuccess(text) {
  const el = document.createElement('div');
  el.className = 'success';
  el.innerHTML = `<div><svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" opacity="0.25"/><path d="m7.5 12.5 3 3 6-7"/></svg><span>${escapeHtml(text)}</span></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 1100);
  setTimeout(() => el.remove(), 1400);
}

// ---------- Lista ----------
let freshId = null;
let syncing = false;

/** Apaga do celular os pontos já enviados há mais de 24 h. */
async function purgeExpired() {
  const now = Date.now();
  for (const p of await getPoints()) {
    if (p.synced && isExpired(p, now)) await deletePoint(p.id);
  }
}

function renderSyncChip(pending, state) {
  const chip = $('#sync-now');
  $('#pending-count').textContent = pending;
  const st = state || (!navigator.onLine && pending ? 'offline' : pending ? 'pending' : 'done');
  chip.className = `sync-chip ${st}`;
  chip.querySelector('use').setAttribute('href', `icons/sprite.svg#${pending || st === 'sending' ? 'cloud-up' : 'check-circle'}`);
}

async function renderList() {
  await purgeExpired();
  const points = (await getPoints()).sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  const pending = points.filter((p) => !p.synced).length;
  renderSyncChip(pending, syncing ? 'sending' : null);
  const ul = $('#points');
  if (!points.length) {
    ul.innerHTML = `<li class="empty-state">${icon('pin')}<div>${escapeHtml(t('list.empty'))}</div></li>`;
    return;
  }
  const now = Date.now();
  ul.innerHTML = points
    .map((p, i) => {
      const coord = formatLatLng(p.lat, p.lng);
      const st = p.synced
        ? `<span class="state sent">${icon('check')}${escapeHtml(t('list.synced'))}</span>`
        : `<span class="state waiting">${icon('clock')}${escapeHtml(t('list.pendingOne'))}</span>`;
      const life = p.synced
        ? `<span class="muted" title="${escapeHtml(t('exp.title'))}">${icon('hourglass')} ${escapeHtml(t('exp.in', { t: formatRemaining(p, now) }))}</span>`
        : '';
      return `<li class="point-card ${p.id === freshId ? 'fresh' : ''}" style="--i:${Math.min(i, 8)}" data-id="${escapeHtml(p.id)}">
        <div class="top"><span class="name">${escapeHtml(p.name)}</span>${st}</div>
        <span class="coord copyable" data-act="copy" role="button" tabindex="0" title="${escapeHtml(t('act.clickCopy'))}">${coord}</span>
        <div class="foot-row">
          <div class="meta"><span class="badge ${accuracyLevel(p.accuracy_m)}">${formatAccuracy(p.accuracy_m)}</span>
            <span>${escapeHtml(formatDate(p.captured_at))}</span>${p.photoBlob ? icon('camera') : ''}${life}</div>
          <div class="actions">
            ${navigator.share ? `<button class="icon-btn small" data-act="share" type="button" title="${escapeHtml(t('act.share'))}">${icon('share')}</button>` : ''}
            <button class="icon-btn small danger" data-act="remove" type="button" title="${escapeHtml(t('act.remove'))}">${icon('trash')}</button>
          </div>
        </div>
        ${p.synced ? `<span class="life" style="width:${(lifeLeft(p, now) * 100).toFixed(1)}%"></span>` : ''}
      </li>`;
    })
    .join('');
  freshId = null;
}
setInterval(() => session && renderList(), 60000);

$('#points').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const p = (await getPoints()).find((x) => x.id === id);
  if (!p) return;
  const coord = formatLatLng(p.lat, p.lng);
  if (btn.dataset.act === 'copy') {
    if (await copyText(coord)) {
      flashCopied(btn);
      toast(`${t('act.copied')} ${coord}`);
    }
  } else if (btn.dataset.act === 'share') {
    const text = `${p.name}\n${coord}\n${formatAccuracy(p.accuracy_m)}\nhttps://maps.google.com/?q=${p.lat},${p.lng}`;
    navigator.share({ title: p.name, text }).catch(() => {});
  } else if (btn.dataset.act === 'remove') {
    if (!confirm(p.synced ? t('list.removeConfirm') : t('list.removePendingConfirm'))) return;
    await deletePoint(id);
    const li = btn.closest('li');
    li.classList.add('removing');
    setTimeout(renderList, 300);
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
  syncing = true;
  renderSyncChip(pending, 'sending');
  let res;
  try {
    res = await syncPending(dataRepo(session.data_token), renderList);
  } finally {
    syncing = false;
  }
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
    if (res.sent) sendHeartbeat();
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
