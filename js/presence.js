// "Quem está online": cada aparelho grava um sinal de vida em
// presence/<aparelho>.json na branch `presence` do repo de dados.
// A branch é separada para não poluir o histórico dos pontos.
import { utf8ToB64 } from './github.js';

export const BRANCH = 'presence';
export const ONLINE_MS = 150 * 1000; // sinal mais novo que 2,5 min = online
export const KEEP_MS = 7 * 24 * 3600 * 1000; // some da lista depois de 7 dias

export function newDeviceId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function platform() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return '';
}

const shas = new Map();

async function ensureBranch(gh) {
  const info = await gh.repoInfo();
  const ref = await gh.req('GET', `git/ref/heads/${info.default_branch}`);
  try {
    await gh.req('POST', 'git/refs', { body: { ref: `refs/heads/${BRANCH}`, sha: ref.object.sha } });
  } catch (e) {
    if (e.status !== 422) throw e; // 422 = já existe
  }
}

/** Grava o sinal de vida deste aparelho. Erros são silenciosos (presença não é crítica). */
export async function heartbeat(gh, record) {
  const path = `presence/${record.device_id}.json`;
  const b64 = utf8ToB64(JSON.stringify({ ...record, last_seen: new Date().toISOString() }) + '\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sha = await gh.putFile(path, b64, `presença ${record.team_label}`, shas.get(path), BRANCH);
      shas.set(path, sha);
      return true;
    } catch (e) {
      if (e.status === 404 || (e.status === 422 && /branch/i.test(e.message))) {
        await ensureBranch(gh);
      } else if (e.status === 409 || e.status === 422) {
        const cur = await gh.getFile(path, BRANCH);
        shas.set(path, cur?.sha);
      } else {
        return false;
      }
    }
  }
  return false;
}

/** Lê todos os sinais de vida (admin). */
export async function readPresence(gh) {
  const entries = (await gh.listDir('presence', BRANCH)).filter((e) => e.type === 'file' && e.name.endsWith('.json'));
  const out = await Promise.all(
    entries.map(async (e) => {
      try {
        const f = await gh.getFile(e.path, BRANCH);
        return f ? { ...JSON.parse(f.text), _sha: e.sha, _path: e.path } : null;
      } catch {
        return null;
      }
    }),
  );
  return out.filter(Boolean);
}

/**
 * Recria a branch `presence` com um único commit contendo só os sinais recentes.
 * Mantém a branch pequena mesmo com muitos sinais por dia.
 */
export async function compactPresence(gh, list) {
  const fresh = list.filter((r) => Date.now() - Date.parse(r.last_seen) < KEEP_MS);
  if (!fresh.length) return;
  const tree = await gh.req('POST', 'git/trees', {
    body: { tree: fresh.map((r) => ({ path: r._path, mode: '100644', type: 'blob', sha: r._sha })) },
  });
  const commit = await gh.req('POST', 'git/commits', { body: { message: 'Compacta presença', tree: tree.sha, parents: [] } });
  await gh.req('PATCH', `git/refs/heads/${BRANCH}`, { body: { sha: commit.sha, force: true } });
  shas.clear();
}

export function presenceStatus(r, now = Date.now()) {
  const age = now - Date.parse(r.last_seen);
  if (age < ONLINE_MS) return r.visible === false ? 'background' : 'online';
  return 'offline';
}
