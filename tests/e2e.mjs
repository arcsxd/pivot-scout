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
const repos = {
  'arcsxd/pivot-scout-data': { token: DATA_TOKEN, files: new Map(), private: true },
  'arcsxd/pivot-scout': { token: SITE_TOKEN, files: new Map(), private: false, commit: 0, trees: new Map(), commits: new Map() },
};
let shaN = 0;
const newSha = () => `sha${++shaN}`;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const textOf = (repo, path) => repos[repo].files.get(path)?.bytes.toString('utf8');

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
    const f = repo.files.get(path);
    if (method === 'GET') {
      if (f) {
        if ((req.headers().accept || '').includes('raw')) return route.fulfill({ status: 200, headers: CORS, body: f.bytes });
        return json(200, { type: 'file', name: path.split('/').pop(), path, sha: f.sha, content: f.bytes.toString('base64') });
      }
      const kids = [...repo.files.entries()].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'));
      if (kids.length) return json(200, kids.map(([k, v]) => ({ type: 'file', name: k.split('/').pop(), path: k, sha: v.sha })));
      return json(404, { message: 'Not Found' });
    }
    if (method === 'PUT') {
      if (f && !body.sha) return json(422, { message: '"sha" wasn\'t supplied.' });
      if (f && body.sha !== f.sha) return json(409, { message: 'sha mismatch' });
      const sha = newSha();
      repo.files.set(path, { bytes: Buffer.from(body.content, 'base64'), sha });
      return json(f ? 200 : 201, { content: { sha, path } });
    }
    if (method === 'DELETE') {
      if (!f) return json(404, { message: 'Not Found' });
      if (body.sha !== f.sha) return json(409, { message: 'sha mismatch' });
      repo.files.delete(path);
      return json(200, { commit: {} });
    }
  }
  if (rest === 'git/ref/heads/main') return json(200, { object: { sha: `c${repo.commit}` } });
  if (rest.startsWith('git/commits/') && method === 'GET') return json(200, { tree: { sha: 'base' } });
  if (rest === 'git/trees' && method === 'POST') {
    const sha = newSha();
    repo.trees.set(sha, body.tree);
    return json(201, { sha });
  }
  if (rest === 'git/commits' && method === 'POST') {
    const sha = newSha();
    repo.commits.set(sha, body.tree);
    return json(201, { sha });
  }
  if (rest === 'git/refs/heads/main' && method === 'PATCH') {
    for (const item of repo.trees.get(repo.commits.get(body.sha))) {
      repo.files.set(item.path, { bytes: Buffer.from(item.content, 'utf8'), sha: newSha() });
    }
    repo.commit++;
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
  const desk = await browser.newContext({ viewport: { width: 1360, height: 860 }, serviceWorkers: 'block', acceptDownloads: true });
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
  assert.ok(rec.photo.startsWith('photos/'));
  await cap.screenshot({ path: join(SHOTS, '6-celular-enviado.png'), fullPage: true });
  log('online de novo: pontos e foto enviados ao repo de dados');

  // ---------- 4. Painel do PC ----------
  const panel = await desk.newPage();
  panel.on('pageerror', (e) => console.error('pageerror(panel):', e));
  await panel.goto(BASE + 'painel.html');
  await panel.fill('#code', code);
  await panel.click('#login-form button');
  await panel.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length === 2, null, { timeout: 20000 });
  assert.equal(await panel.locator('.leaflet-interactive').count() >= 2, true);
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

  await panel.locator('#rows tr', { hasText: 'Santa Rita' }).locator('button[data-act=photo]').click();
  await panel.waitForFunction(() => document.querySelector('#photo-img').naturalWidth > 0);
  await panel.click('#photo-close');
  log('foto abre no painel');

  await panel.selectOption('#filter', 'pendente');
  await panel.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length === 1);
  await panel.selectOption('#filter', 'all');

  const [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('#export-kml')]);
  const kml = await readFile(await dl.path(), 'utf8');
  assert.ok(kml.includes('<name>Pivot 12 (Santa Rita)</name>'));
  assert.ok(kml.includes('<coordinates>-47.9292345,-15.7801000,0</coordinates>'));
  const [dl2] = await Promise.all([panel.waitForEvent('download'), panel.click('#export-geo')]);
  assert.equal(JSON.parse(await readFile(await dl2.path(), 'utf8')).features.length, 2);
  log('exportação KML e GeoJSON');

  await panel.locator('#rows tr', { hasText: 'Pivot 12' }).click();
  await panel.waitForSelector('.leaflet-popup');
  await panel.screenshot({ path: join(SHOTS, '8-painel-popup.png') });

  panel.once('dialog', (d) => d.accept());
  await panel.locator('#rows tr', { hasText: 'Santa Rita' }).locator('button[data-act=delete]').click();
  await panel.waitForFunction(() => document.querySelectorAll('#rows tr[data-id]').length === 1);
  assert.ok(!repos['arcsxd/pivot-scout-data'].files.has(path12));
  assert.equal([...repos['arcsxd/pivot-scout-data'].files.keys()].filter((k) => k.startsWith('photos/')).length, 0);
  log('apagar remove ponto e foto');

  // Senha de admin também entra no painel.
  const panel2 = await desk.newPage();
  await panel2.goto(BASE + 'painel.html');
  await panel2.evaluate(() => localStorage.clear());
  await panel2.reload();
  await panel2.fill('#code', ADMIN_PW);
  await panel2.click('#login-form button');
  await panel2.waitForSelector('#admin-link:not([hidden])');
  log('senha de admin entra no painel');

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
