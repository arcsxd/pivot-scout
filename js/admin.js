// Painel de admin: criar e revogar códigos de equipe, trocar token e senha.
import { $, copyText, escapeHtml, formatDate, toast } from './ui.js';
import { siteRepo, dataRepo } from './auth.js';
import { readPresence, compactPresence, presenceStatus, KEEP_MS } from './presence.js';
import { formatAccuracy, accuracyLevel } from './geo.js';
import { decryptJSON } from './crypto.js';
import { buildTeam, checkDataToken, reencryptTeams, writeConfig, MIN_ADMIN_PASSWORD } from './adminlib.js';

let password = null; // só em memória
let payload = null; // { admin_token, data_token, codes }
let teams = [];
let site = null;

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Gravando…';
  try {
    await fn();
  } catch (e) {
    toast(e.message || String(e), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** Lê a versão mais recente direto da API (o Pages pode estar atrasado). */
async function reload() {
  const [tf, af] = await Promise.all([site.getJSON('teams.json'), site.getJSON('admin.json')]);
  teams = tf?.data?.teams || [];
  if (af?.data?.enc) {
    const fresh = await decryptJSON(af.data.enc, password);
    if (fresh) payload = fresh;
  }
  payload.codes ||= {};
  render();
}

function render() {
  const ul = $('#teams');
  if (!teams.length) {
    ul.innerHTML = '<li class="muted">Nenhum código ainda.</li>';
    return;
  }
  ul.innerHTML = teams
    .map((tm) => {
      const code = payload.codes[tm.id];
      return `<li data-id="${escapeHtml(tm.id)}">
        <div class="title"><span>${escapeHtml(tm.label)}</span><span class="badge info">${escapeHtml(tm.id)}</span></div>
        <div class="meta">Criado ${escapeHtml(formatDate(tm.created_at))}</div>
        <div class="meta">Código: <span class="mono" data-code>${code ? '•••-•••••-•••••' : '(desconhecido)'}</span></div>
        <div class="row">
          ${code ? '<button class="btn small" data-act="show" type="button">Mostrar</button><button class="btn small" data-act="copy" type="button">Copiar</button>' : ''}
          <button class="btn-danger small" data-act="revoke" type="button">Revogar</button>
        </div>
      </li>`;
    })
    .join('');
}

async function save(message) {
  await writeConfig(site, teams, payload, password, message);
}

// ---------- Login ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-form button');
  const err = $('#login-err');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Verificando…';
  try {
    const pw = $('#pw').value;
    const res = await fetch(`admin.json?t=${Date.now()}`, { cache: 'no-store' });
    const admin = res.ok ? await res.json() : null;
    if (!admin?.enc) {
      err.innerHTML = 'admin.json não encontrado. Faça a <a href="tools/setup.html">configuração inicial</a>.';
      return;
    }
    const p = await decryptJSON(admin.enc, pw);
    if (!p?.admin_token) {
      err.textContent = 'Senha incorreta.';
      return;
    }
    password = pw;
    payload = p;
    site = siteRepo(p.admin_token);
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#logout').hidden = false;
    await reload();
    startPresence();
  } catch (e2) {
    err.textContent = e2.message || String(e2);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

$('#logout').addEventListener('click', () => location.reload());

// ---------- Quem está online ----------
let compacted = false;

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} dia(s)`;
}

const STATUS = {
  online: ['good', 'Online'],
  background: ['ok', 'Em segundo plano'],
  offline: ['', 'Offline'],
};

let presence = [];

function renderPresence() {
  const ul = $('#presence');
  const now = Date.now();
  const list = presence
    .filter((r) => now - Date.parse(r.last_seen) < KEEP_MS)
    .map((r) => ({ ...r, _st: presenceStatus(r, now) }))
    .sort((a, b) => {
      const order = { online: 0, background: 1, offline: 2 };
      return order[a._st] - order[b._st] || b.last_seen.localeCompare(a.last_seen);
    });
  const online = list.filter((r) => r._st !== 'offline').length;
  $('#presence-summary').textContent = `${online} online`;
  $('#presence-summary').className = `badge ${online ? 'good' : ''}`;
  if (!list.length) {
    ul.innerHTML = '<li class="muted">Nenhum aparelho conectou ainda.</li>';
    return;
  }
  ul.innerHTML = list
    .map((r) => {
      const [cls, label] = STATUS[r._st];
      const who = r.operator ? `${escapeHtml(r.operator)} <span class="muted">· ${escapeHtml(r.team_label)}</span>` : escapeHtml(r.team_label);
      const icon = r.app === 'painel' ? '💻' : '📱';
      const kind = r.app === 'painel' ? 'Painel do PC' : 'App de captura';
      const extra = [];
      if (r.app !== 'painel') {
        if (r.pending) extra.push(`<span class="badge ok">${r.pending} pendente(s)</span>`);
        if (r.gps?.accuracy != null) extra.push(`<span class="badge ${accuracyLevel(r.gps.accuracy)}">GPS ${formatAccuracy(r.gps.accuracy)}</span>`);
        if (r.last_capture_at) extra.push(`<span>última captura ${escapeHtml(ago(r.last_capture_at))}</span>`);
      }
      return `<li class="presence-${r._st}">
        <div class="title"><span><span class="presence-dot ${cls}" aria-hidden="true"></span>${icon} ${who}</span><span class="badge ${cls}">${label}</span></div>
        <div class="meta"><span>${kind}${r.platform ? ' · ' + escapeHtml(r.platform) : ''}</span><span>visto ${escapeHtml(ago(r.last_seen))}</span>${extra.join('')}</div>
      </li>`;
    })
    .join('');
}

async function loadPresence() {
  try {
    const gh = dataRepo(payload.data_token);
    presence = await readPresence(gh);
    renderPresence();
    if (!compacted && presence.length) {
      compacted = true;
      compactPresence(gh, presence).catch(() => {});
    }
  } catch (e) {
    $('#presence').innerHTML = `<li class="error">Não foi possível ler a presença: ${escapeHtml(e.message)}</li>`;
  }
}

function startPresence() {
  loadPresence();
  setInterval(() => {
    if (document.visibilityState === 'visible') loadPresence();
  }, 20000);
  setInterval(renderPresence, 5000); // atualiza o "visto há"
}

// ---------- Novo código ----------
$('#new-team').addEventListener('submit', (e) => {
  e.preventDefault();
  const label = $('#team-label').value.trim();
  if (!label) return;
  busy($('#new-team button'), async () => {
    await reload();
    const { team, code } = await buildTeam(label, payload.data_token, teams.map((x) => x.id));
    teams.push(team);
    payload.codes[team.id] = code;
    await save(`Novo código de equipe: ${label}`);
    $('#team-label').value = '';
    $('#new-code-value').textContent = code;
    $('#new-code').hidden = false;
    render();
    toast('Código criado.');
  });
});

$('#copy-new').addEventListener('click', async () => {
  if (await copyText($('#new-code-value').textContent)) toast('Código copiado.');
});

// ---------- Lista ----------
$('#teams').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const li = btn.closest('li');
  const tm = teams.find((x) => x.id === li.dataset.id);
  if (!tm) return;
  const code = payload.codes[tm.id];
  if (btn.dataset.act === 'show') {
    li.querySelector('[data-code]').textContent = code;
  } else if (btn.dataset.act === 'copy') {
    if (await copyText(code)) toast('Código copiado.');
  } else if (btn.dataset.act === 'revoke') {
    if (!confirm(`Revogar o código de "${tm.label}"? Ninguém mais consegue entrar com ele.`)) return;
    busy(btn, async () => {
      await reload();
      teams = teams.filter((x) => x.id !== tm.id);
      delete payload.codes[tm.id];
      await save(`Revoga código de equipe: ${tm.label}`);
      render();
      toast('Código revogado.');
    });
  }
});

// ---------- Trocar token ----------
$('#rotate').addEventListener('submit', (e) => {
  e.preventDefault();
  const token = $('#new-token').value.trim();
  busy($('#rotate button'), async () => {
    await checkDataToken(token);
    await reload();
    const { teams: updated, missing } = await reencryptTeams(teams, payload.codes, token);
    teams = updated;
    payload.data_token = token;
    await save('Troca token de dados');
    $('#new-token').value = '';
    render();
    toast(missing.length ? `Token trocado. Recrie os códigos de: ${missing.join(', ')}` : 'Token trocado. Revogue o token antigo no GitHub.');
  });
});

// ---------- Trocar senha ----------
$('#change-pw').addEventListener('submit', (e) => {
  e.preventDefault();
  const a = $('#pw1').value;
  const b = $('#pw2').value;
  if (a.length < MIN_ADMIN_PASSWORD) return toast(`Use pelo menos ${MIN_ADMIN_PASSWORD} caracteres.`, 'error');
  if (a !== b) return toast('As senhas não conferem.', 'error');
  busy($('#change-pw button'), async () => {
    await reload();
    password = a;
    await save('Troca senha de admin');
    $('#pw1').value = '';
    $('#pw2').value = '';
    toast('Senha trocada.');
  });
});

$('#login').hidden = false;
$('#pw').focus();
