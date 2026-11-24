// Teste ponta a ponta com Playwright e uma API do GitHub simulada em memória.
// Uso: node tests/e2e.mjs [pasta-de-screenshots]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv[2] || join(ROOT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

// ---------- Servidor estático (imita o GitHub Pages em /pivot-scout/) ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (!p.startsWith('/pivot-scout/')) return res.writeHead(404).end();
  p = p.slice('/pivot-scout/'.length) || 'index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/pivot-scout/`;

// ---------- GitHub simulado ----------
const DATA_TOKEN = 'github_pat_DATA_test';
const SITE_TOKEN = 'github_pat_SITE_test';
function makeRepo(token, isPrivate) {
  const main = new Map();
  return { token, private: isPrivate, files: main, branches: { main }, heads: { main: 0 }, trees: new Map(), commits: new Map() };
}
const repos = {
  'arcsxd/pivot-scout-data': makeRepo(DATA_TOKEN, true),
  'arcsxd/pivot-scout': makeRepo(SITE_TOKEN, false),
};
let shaN = 0;
const newSha = () => `sha${++shaN}`;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'ETag' };
let notModified = 0;
const textOf = (repo, path, branch = 'main') => repos[repo].branches[branch]?.get(path)?.bytes.toString('utf8');

function blobBySha(repo, sha) {
  for (const map of Object.values(repo.branches)) for (const f of map.values()) if (f.sha === sha) return f.bytes;
  return null;
}

async function github(route) {
  const req = route.request();
  const json = (status, obj) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const url = new URL(req.url());
  const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/?(.*)$/);
  const repo = m && repos[m[1]];
  if (!repo) return json(404, { message: 'Not Found' });
  if (req.headers().authorization !== `Bearer ${repo.token}`) return json(401, { message: 'Bad credentials' });
  const rest = decodeURIComponent(m[2]);
  const method = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;

  if (rest === '' && method === 'GET') return json(200, { default_branch: 'main', private: repo.private });

  if (rest.startsWith('contents/')) {
    const path = rest.slice('contents/'.length);
    const branch = (method === 'GET' ? url.searchParams.get('ref') : body?.branch) || 'main';
    const files = repo.branches[branch];
    if (!files) return json(404, { message: method === 'GET' ? `No commit found for the ref ${branch}` : `Branch ${branch} not found` });
    const f = files.get(path);
    if (method === 'GET') {
      if (f) {
        if ((req.headers().accept || '').includes('raw')) return route.fulfill({ status: 200, headers: CORS, body: f.bytes });
        return json(200, { type: 'file', name: path.split('/').pop(), path, sha: f.sha, size: f.bytes.length, content: f.bytes.toString('base64') });
      }
      const kids = [...files.entries()].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'));
      if (kids.length) {
        const list = kids.map(([k, v]) => ({ type: 'file', name: k.split('/').pop(), path: k, sha: v.sha }));
        const etag = '"' + list.map((x) => x.sha).join('.') + '"';
        if (req.headers()['if-none-match'] === etag) {
          notModified++;
          return route.fulfill({ status: 304, headers: { ...CORS, etag } });
        }
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json', etag }, body: JSON.stringify(list) });
      }
      return json(404, { message: 'Not Found' });
    }
    if (method === 'PUT') {
      if (f && !body.sha) return json(422, { message: '"sha" wasn\'t supplied.' });
      if (f && body.sha !== f.sha) return json(409, { message: 'sha mismatch' });
      const sha = newSha();
      files.set(path, { bytes: Buffer.from(body.content, 'base64'), sha });
      repo.heads[branch]++;
      return json(f ? 200 : 201, { content: { sha, path } });
    }
    if (method === 'DELETE') {
      if (!f) return json(404, { message: 'Not Found' });
      if (body.sha !== f.sha) return json(409, { message: 'sha mismatch' });
      files.delete(path);
      repo.heads[branch]++;
      return json(200, { commit: {} });
    }
  }
  let mm;
  if ((mm = rest.match(/^git\/ref\/heads\/(.+)$/))) {
    if (!repo.branches[mm[1]]) return json(404, { message: 'Not Found' });
    return json(200, { object: { sha: `c-${mm[1]}-${repo.heads[mm[1]]}` } });
  }
  if (rest === 'git/refs' && method === 'POST') {
    const name = body.ref.replace('refs/heads/', '');
    if (repo.branches[name]) return json(422, { message: 'Reference already exists' });
    const from = body.sha.split('-')[1];
    repo.branches[name] = new Map(repo.branches[from]);
    repo.heads[name] = 0;
    return json(201, {});
  }
  if (rest.startsWith('git/commits/') && method === 'GET') return json(200, { tree: { sha: 'base' } });
  if (rest === 'git/trees' && method === 'POST') {
    const sha = newSha();
    repo.trees.set(sha, { base: !!body.base_tree, items: body.tree });
    return json(201, { sha });
  }
  if (rest === 'git/commits' && method === 'POST') {
    const sha = newSha();
    repo.commits.set(sha, body.tree);
    return json(201, { sha });
  }
  if ((mm = rest.match(/^git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
    const tree = repo.trees.get(repo.commits.get(body.sha));
    const target = tree.base ? repo.branches[mm[1]] : new Map();
    for (const item of tree.items) {
      const bytes = item.content != null ? Buffer.from(item.content, 'utf8') : blobBySha(repo, item.sha);
      target.set(item.path, { bytes, sha: item.content != null ? newSha() : item.sha });
    }
    repo.branches[mm[1]] = target;
    if (mm[1] === 'main') repo.files = target;
    repo.heads[mm[1]]++;
    if (body.force) repo.compactions = (repo.compactions || 0) + 1;
    return json(200, {});
  }
  return json(404, { message: `mock: ${method} ${rest}` });
}

/** teams.json/admin.json "publicados" no Pages = o que está no repo do site. */
async function pages(route) {
  const name = new URL(route.request().url()).pathname.split('/').pop();
  const text = textOf('arcsxd/pivot-scout', name);
  if (text == null) return route.fallback();
  return route.fulfill({ status: 200, contentType: 'application/json', body: text });
}

async function wire(ctx) {
  await ctx.route('https://api.github.com/**', github);
  await ctx.route(/\/pivot-scout\/(teams|admin)\.json/, pages);
  await ctx.route(/arcgisonline\.com/, (r) => r.abort());
}

const browser = await chromium.launch();
const ADMIN_PW = 'senha-admin-123';
const log = (...a) => console.log('✓', ...a);

try {
  // ---------- 1. Configuração inicial ----------
  const desk = await browser.newContext({ viewport: { width: 1360, height: 860 }, serviceWorkers: 'block', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await wire(desk);
  const setup = await desk.newPage();
  setup.on('pageerror', (e) => console.error('pageerror(setup):', e));
  await setup.goto(BASE + 'tools/setup.html');
  await setup.fill('#data-token', DATA_TOKEN);
  await setup.fill('#site-token', SITE_TOKEN);
  await setup.fill('#pw1', ADMIN_PW);
  await setup.fill('#pw2', ADMIN_PW);
  await setup.fill('#first-team', 'Equipe Pelican');
  await setup.click('#setup button[type=submit]');
  await setup.waitForSelector('#done:not([hidden])', { timeout: 20000 });
  const code = (await setup.textContent('#first-code-value')).trim();
  assert.match(code, /^[A-Z0-9]{3}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  assert.ok(!textOf('arcsxd/pivot-scout', 'admin.json').includes(DATA_TOKEN), 'token não pode estar em texto puro');
  assert.ok(!textOf('arcsxd/pivot-scout', 'teams.json').includes(DATA_TOKEN));
  assert.ok(repos['arcsxd/pivot-scout-data'].files.has('points/.keep'));
  await setup.screenshot({ path: join(SHOTS, '1-setup.png') });
  log('setup gravou admin.json e teams.json criptografados; código', code);

  // ---------- 2. Admin: criar e revogar código ----------
  const admin = await desk.newPage();
  admin.on('pageerror', (e) => console.error('pageerror(admin):', e));
  await admin.goto(BASE + 'admin.html');
  await admin.fill('#pw', 'senha-errada-xx');
  await admin.click('#login-form button');
  await admin.waitForFunction(() => document.querySelector('#login-err').textContent.includes('incorreta'));
  await admin.fill('#pw', ADMIN_PW);
  await admin.click('#login-form button');
  await admin.waitForSelector('#app:not([hidden])');
  await admin.fill('#team-label', 'Equipe Sul');
  await admin.click('#new-team button');
  await admin.waitForSelector('#new-code:not([hidden])', { timeout: 20000 });
  const code2 = (await admin.textContent('#new-code-value')).trim();
  assert.equal(JSON.parse(textOf('arcsxd/pivot-scout', 'teams.json')).teams.length, 2);
  await admin.waitForFunction(() => document.querySelectorAll('#teams li').length === 2);
  await admin.screenshot({ path: join(SHOTS, '2-admin.png'), fullPage: true });
  admin.once('dialog', (d) => d.accept());
  await admin.click(`#teams li:has-text("Equipe Sul") button[data-act=revoke]`);
  await admin.waitForFunction(() => document.querySelectorAll('#teams li').length === 1, null, { timeout: 20000 });
  assert.equal(JSON.parse(textOf('arcsxd/pivot-scout', 'teams.json')).teams.length, 1);
  log('admin criou e revogou código', code2);

  // ---------- 3. Celular: login, captura offline, sync ----------
  const phone = await browser.newContext({
    ...devices['Pixel 7'],
    permissions: ['geolocation'],
    geolocation: { latitude: -15.7801234, longitude: -47.9292345, accuracy: 4 },
    serviceWorkers: 'block',
  });
  await wire(phone);
  const cap = await phone.newPage();
  cap.on('pageerror', (e) => console.error('pageerror(capture):', e));
  await cap.goto(BASE + 'index.html');
  await cap.fill('#code', code2);
  await cap.click('#login-form button');
  await cap.waitForFunction(() => document.querySelector('#login-err').textContent.length > 0);
  log('código revogado é recusado');
  await cap.fill('#code', code.toLowerCase());
  await cap.fill('#operator', 'João');
  await cap.click('#login-form button');
  await cap.waitForSelector('#app:not([hidden])');
  await cap.waitForFunction(() => !document.querySelector('#capture').disabled);
  assert.equal(await cap.textContent('#lat'), '-15.780123');
  assert.match(await cap.getAttribute('#acc', 'class'), /good/);
  await cap.screenshot({ path: join(SHOTS, '3-celular-gps.png') });

  await phone.setOffline(true);
  await cap.click('#capture');
  await cap.waitForSelector('#save-form:not([hidden])');
  await cap.click('#save-form button[type=submit]');
  assert.ok((await cap.textContent('#name-err')).length > 0, 'nome é obrigatório');
  await cap.fill('#name', 'Pivot 12 – Fazenda Santa Rita');
  await cap.setInputFiles('#photo', join(ROOT, 'icons/icon-512.png'));
  await cap.waitForSelector('#photo-preview:not([hidden])');
  await cap.screenshot({ path: join(SHOTS, '4-celular-salvar.png') });
  await cap.click('#save-form button[type=submit]');
  await cap.waitForFunction(() => document.querySelector('#pending-count').textContent === '1');
  await cap.waitForFunction(() => document.querySelector('#sync-msg').textContent.length > 0);
  assert.equal([...repos['arcsxd/pivot-scout-data'].files.keys()].filter((k) => k.endsWith('.json')).length, 0);
  await cap.screenshot({ path: join(SHOTS, '5-celular-offline.png'), fullPage: true });
  log('sem internet: ponto fica pendente no celular');

  // Segundo ponto, com precisão ruim, ainda offline.
  await phone.setGeolocation({ latitude: -15.7855, longitude: -47.9341, accuracy: 14 });
  await cap.waitForFunction(() => document.querySelector('#acc').className.includes('bad'));
  await cap.click('#capture');
  await cap.fill('#name', 'Pivot 13');
  await cap.click('#save-form button[type=submit]');
  await cap.waitForFunction(() => document.querySelector('#pending-count').textContent === '2');

  await phone.setOffline(false);
  await cap.waitForFunction(() => document.querySelector('#pending-count').textContent === '0', null, { timeout: 20000 });
  const dataFiles = [...repos['arcsxd/pivot-scout-data'].files.keys()];
  const pointFiles = dataFiles.filter((k) => k.startsWith('points/') && k.endsWith('.json'));
  assert.equal(pointFiles.length, 2);
  assert.equal(dataFiles.filter((k) => k.startsWith('photos/')).length, 1);
  const rec = pointFiles.map((k) => JSON.parse(textOf('arcsxd/pivot-scout-data', k))).find((r) => r.name.startsWith('Pivot 12'));
  assert.equal(rec.lat, -15.7801234);
  assert.equal(rec.lng, -47.9292345);
  assert.equal(rec.accuracy_m, 4);
  assert.equal(rec.status, 'pendente');
  assert.equal(rec.team_label, 'Equipe Pelican');
  assert.equal(rec.operator, 'João');
  assert.ok(rec.photo.startsWith('photos/'));
  await cap.locator('#points li', { hasText: 'Pivot 13' }).locator('.copyable').click();
  await cap.waitForFunction(() => document.querySelector('#toast').textContent.includes('-15.785500, -47.934100'));
  log('celular: tocar na coordenada copia');
  await cap.screenshot({ path: join(SHOTS, '6-celular-enviado.png'), fullPage: true });
  log('online de novo: pontos e foto enviados ao repo de dados');

  // ---------- 4. Painel do PC ----------
  const panel = await desk.newPage();
  // Notificação do sistema simulada (registra o que seria mostrado).
  await panel.addInitScript(() => {
    window.__notes = [];
    window.__focus = true;
    document.hasFocus = () => window.__focus;
    window.Notification = class {
      static permission = 'default';
      static async requestPermission() {
        window.Notification.permission = 'granted';
        return 'granted';
      }
      constructor(title, opts) {
        window.__notes.push({ title, body: opts?.body || '' });
      }
      close() {}
    };
  });
  panel.on('pageerror', (e) => console.error('pageerror(panel):', e));
  await panel.goto(BASE + 'painel.html');
  await panel.fill('#code', code);
  await panel.click('#login-form button');
  await panel.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length === 2, null, { timeout: 20000 });
  assert.equal(await panel.locator('.leaflet-interactive').count() >= 2, true);

  // Importar KMZ da fazenda
  await panel.click('#farms-btn');
  panel.once('dialog', (d) => d.accept(d.defaultValue()));
  await panel.setInputFiles('#farm-file', join(ROOT, 'tests/fixtures/fazenda.kmz'));
  await panel.waitForFunction(() => document.querySelector('#farms-count').textContent === '1' || document.querySelector('#farm-err').textContent, null, { timeout: 20000 });
  assert.equal(await panel.textContent('#farm-err'), '', 'erro ao importar');
  const farmFiles = [...repos['arcsxd/pivot-scout-data'].files.keys()].filter((k) => k.startsWith('farms/'));
  assert.equal(farmFiles.length, 1);
  const farmRec = JSON.parse(textOf('arcsxd/pivot-scout-data', farmFiles[0]));
  assert.equal(farmRec.name, 'Fazenda Santa Rita');
  assert.equal(farmRec.geojson.features.length, 2);
  assert.equal(farmRec.geojson.features[0].geometry.coordinates.length, 2, 'polígono com buraco');
  await panel.screenshot({ path: join(SHOTS, '7b-fazendas.png') });
  await panel.click('#farm-close');
  const farmCell = async (name) => panel.locator('#rows tr', { hasText: name }).locator('td').nth(3).textContent();
  assert.equal(await farmCell('Pivot 12'), 'Fazenda Santa Rita · Talhão 1');
  assert.equal(await farmCell('Pivot 13'), '');
  log('KMZ importado; ponto dentro da fazenda identificado');

  // Clicar na coordenada copia
  await panel.locator('#rows tr', { hasText: 'Pivot 12' }).locator('td.copyable').click();
  assert.equal(await panel.evaluate(() => navigator.clipboard.readText()), '-15.780123, -47.929234');
  log('painel: clicar na coordenada copia');

  // Ativar notificações
  assert.match(await panel.textContent('#notify-btn'), /Ativar notificações/);
  await panel.click('#notify-btn');
  await panel.waitForFunction(() => window.__notes.length === 1);
  assert.match(await panel.textContent('#notify-btn'), /🔔/);
  log('notificações ativadas (com aviso de teste)');

  // Atualização automática: ponto novo capturado no celular aparece sozinho
  await panel.evaluate(() => (window.__focus = false));
  await panel.selectOption('#auto', '10');
  await panel.waitForFunction(() => document.querySelector('#live').classList.contains('ok'));
  await phone.setGeolocation({ latitude: -15.7790, longitude: -47.9300, accuracy: 3 });
  await cap.waitForFunction(() => document.querySelector('#acc').className.includes('good'));
  await cap.click('#capture');
  await cap.fill('#name', 'Pivot 14');
  await cap.click('#save-form button[type=submit]');
  await cap.waitForFunction(() => document.querySelector('#pending-count').textContent === '0', null, { timeout: 20000 });
  await panel.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length === 3, null, { timeout: 25000 });
  assert.match(await panel.locator('#rows tr', { hasText: 'Pivot 14' }).getAttribute('class'), /is-new/);
  await panel.waitForFunction(() => document.querySelector('#toast').textContent.includes('Pivot 14'));
  await panel.waitForFunction(() => window.__notes.length === 2);
  const note = (await panel.evaluate(() => window.__notes))[1];
  assert.equal(note.title, 'Novo ponto: Pivot 14');
  assert.ok(note.body.includes('-15.779000, -47.930000'), note.body);
  assert.ok(note.body.includes('Fazenda Santa Rita · Talhão 1'), note.body);
  assert.match(await panel.title(), /^\(1\) /);
  await panel.evaluate(() => (window.__focus = true));
  log('notificação do sistema enviada: ' + note.title + ' | ' + note.body.replace('\n', ' | '));
  assert.equal(await panel.locator('#rows tr', { hasText: 'Pivot 14' }).locator('td').nth(3).textContent(), 'Fazenda Santa Rita · Talhão 1');
  await panel.screenshot({ path: join(SHOTS, '7c-painel-ao-vivo.png') });
  await panel.waitForTimeout(11000);
  assert.ok(notModified > 0, 'consultas sem mudança devem voltar 304');
  log(`painel atualiza sozinho e destaca ponto novo (${notModified} consulta(s) 304)`);
  await panel.screenshot({ path: join(SHOTS, '7-painel.png') });

  const row12 = panel.locator('#rows tr', { hasText: 'Pivot 12' });
  await row12.locator('button[data-act=toggle]').click();
  await panel.waitForFunction(() => [...document.querySelectorAll('#rows tr')].some((tr) => tr.textContent.includes('Pivot 12') && tr.textContent.includes('Lançado')));
  const path12 = `points/${rec.id}.json`;
  assert.equal(JSON.parse(textOf('arcsxd/pivot-scout-data', path12)).status, 'lancado');
  log('marcar como lançado gravou status');

  await row12.locator('button[data-act=edit]').click();
  await panel.fill('#edit-name', 'Pivot 12 (Santa Rita)');
  await panel.fill('#edit-lat', '-15,7801');
  await panel.click('#edit-form button[type=submit]');
  await panel.waitForFunction(() => document.querySelector('#rows').textContent.includes('Pivot 12 (Santa Rita)'));
  const edited = JSON.parse(textOf('arcsxd/pivot-scout-data', path12));
  assert.equal(edited.name, 'Pivot 12 (Santa Rita)');
  assert.equal(edited.lat, -15.7801);
  log('edição gravada');

  await panel.locator('#rows tr', { hasText: 'Pivot 12 (Santa Rita)' }).locator('button[data-act=photo]').click();
  await panel.waitForFunction(() => document.querySelector('#photo-img').naturalWidth > 0);
  await panel.click('#photo-close');
  log('foto abre no painel');

  await panel.selectOption('#filter', 'pendente');
  await panel.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length === 2);
  await panel.selectOption('#filter', 'all');

  const [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('#export-kml')]);
  const kml = await readFile(await dl.path(), 'utf8');
  assert.ok(kml.includes('<name>Pivot 12 (Santa Rita)</name>'));
  assert.ok(kml.includes('<coordinates>-47.9292345,-15.7801000,0</coordinates>'));
  assert.ok(kml.includes('Fazenda: Fazenda Santa Rita · Talhão 1'));
  const [dl2] = await Promise.all([panel.waitForEvent('download'), panel.click('#export-geo')]);
  assert.equal(JSON.parse(await readFile(await dl2.path(), 'utf8')).features.length, 3);
  log('exportação KML e GeoJSON');

  await panel.locator('#rows tr', { hasText: 'Pivot 12' }).locator('td').nth(1).click();
  await panel.waitForSelector('.leaflet-popup');
  await panel.locator('.leaflet-popup .copyable').click();
  assert.equal(await panel.evaluate(() => navigator.clipboard.readText()), '-15.780100, -47.929234');
  log('popup do mapa: clicar na coordenada copia');
  await panel.screenshot({ path: join(SHOTS, '8-painel-popup.png') });

  panel.once('dialog', (d) => d.accept());
  await panel.locator('#rows tr', { hasText: 'Pivot 12 (Santa Rita)' }).locator('button[data-act=delete]').click();
  await panel.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length === 2);
  assert.ok(!repos['arcsxd/pivot-scout-data'].files.has(path12));
  assert.equal([...repos['arcsxd/pivot-scout-data'].files.keys()].filter((k) => k.startsWith('photos/')).length, 0);
  log('apagar remove ponto e foto');

  await panel.click('#farms-btn');
  panel.once('dialog', (d) => d.accept());
  await panel.click('#farm-list button[data-act=remove]');
  await panel.waitForFunction(() => document.querySelector('#farms-count').textContent === '0');
  assert.equal([...repos['arcsxd/pivot-scout-data'].files.keys()].filter((k) => k.startsWith('farms/')).length, 0);
  await panel.click('#farm-close');
  log('remover fazenda');

  // Senha de admin também entra no painel.
  const panel2 = await desk.newPage();
  await panel2.goto(BASE + 'painel.html');
  await panel2.evaluate(() => localStorage.clear());
  await panel2.reload();
  await panel2.fill('#code', ADMIN_PW);
  await panel2.click('#login-form button');
  await panel2.waitForSelector('#admin-link:not([hidden])');
  log('senha de admin entra no painel');

  // ---------- Admin: quem está online ----------
  const presenceFiles = () => [...(repos['arcsxd/pivot-scout-data'].branches.presence?.keys() || [])].filter((k) => k.startsWith('presence/'));
  assert.ok(presenceFiles().length >= 2, 'celular e painel mandam sinal de vida: ' + presenceFiles());
  const admin2 = await desk.newPage();
  admin2.on('pageerror', (e) => console.error('pageerror(admin2):', e));
  await admin2.goto(BASE + 'admin.html');
  await admin2.fill('#pw', ADMIN_PW);
  await admin2.click('#login-form button');
  await admin2.waitForFunction(() => document.querySelectorAll('#presence li[class^="presence-"]').length >= 2, null, { timeout: 20000 });
  const phoneRow = admin2.locator('#presence li', { hasText: 'João' });
  assert.match(await phoneRow.textContent(), /Online/);
  assert.match(await phoneRow.textContent(), /App de captura/);
  assert.match(await phoneRow.textContent(), /Equipe Pelican/);
  assert.match(await phoneRow.textContent(), /GPS ±3\.0 m/);
  assert.match(await admin2.locator('#presence li', { hasText: 'Painel do PC' }).first().textContent(), /Online/);
  assert.match(await admin2.textContent('#presence-summary'), /[1-9]\d* online/);
  await admin2.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(repos['arcsxd/pivot-scout-data'].compactions >= 1, 'branch de presença compactada');
  assert.ok([...repos['arcsxd/pivot-scout-data'].branches.presence.keys()].every((k) => k.startsWith('presence/')));
  await admin2.locator('#presence').scrollIntoViewIfNeeded();
  await admin2.screenshot({ path: join(SHOTS, '9-admin-online.png') });

  // Celular sai do app: aparece "Em segundo plano"
  await cap.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await new Promise((r) => setTimeout(r, 800));
  await admin2.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await admin2.reload();
  await admin2.fill('#pw', ADMIN_PW);
  await admin2.click('#login-form button');
  await admin2.waitForFunction(() => /Em segundo plano/.test(document.querySelector('#presence').textContent), null, { timeout: 20000 });
  log('admin vê quem está online (João no celular, painel no PC) e quem saiu do app');

  // ---------- 5. Offline com service worker ----------
  const sw = await browser.newContext({ ...devices['Pixel 7'] });
  await wire(sw);
  const swPage = await sw.newPage();
  await swPage.goto(BASE + 'index.html');
  await swPage.evaluate(() => navigator.serviceWorker.ready);
  await swPage.waitForTimeout(500);
  await sw.setOffline(true);
  await swPage.reload();
  await swPage.waitForSelector('#login:not([hidden])');
  log('app abre sem internet (service worker)');

  console.log('\nTODOS OS TESTES PASSARAM. Screenshots em', SHOTS);
} finally {
  await browser.close();
  server.close();
}
