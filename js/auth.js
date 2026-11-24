// Login por código de equipe ou senha de admin.
// teams.json e admin.json são públicos (servidos pelo GitHub Pages), mas os
// tokens dentro deles só abrem com o código / senha certos.
import { decryptJSON, parseCode } from './crypto.js';
import { GitHub } from './github.js';
import { DATA_OWNER, DATA_REPO, SITE_OWNER, SITE_REPO } from './config.js';

export function siteBase() {
  // Funciona tanto na raiz quanto em /tools/.
  return new URL(location.pathname.includes('/tools/') ? '../' : './', location.href);
}

export async function loadPublicJSON(name) {
  try {
    const res = await fetch(new URL(`${name}?t=${Date.now()}`, siteBase()), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function loginWithCode(code) {
  const parsed = parseCode(code);
  if (!parsed) return null;
  const teams = await loadPublicJSON('teams.json');
  const team = teams?.teams?.find((t) => t.id === parsed.id);
  if (!team) return null;
  const payload = await decryptJSON(team.enc, parsed.secret);
  if (!payload?.data_token) return null;
  return { role: 'team', team_id: team.id, team_label: team.label, data_token: payload.data_token };
}

/** Retorna o conteúdo completo do admin.json descriptografado, ou null. */
export async function unlockAdmin(password) {
  const admin = await loadPublicJSON('admin.json');
  if (!admin?.enc) return null;
  return decryptJSON(admin.enc, password);
}

export async function loginAdmin(password) {
  const payload = await unlockAdmin(password);
  if (!payload?.data_token) return null;
  return { role: 'admin', team_id: 'ADMIN', team_label: 'Admin', data_token: payload.data_token };
}

export const dataRepo = (token) => new GitHub({ token, owner: DATA_OWNER, repo: DATA_REPO });
export const siteRepo = (token) => new GitHub({ token, owner: SITE_OWNER, repo: SITE_REPO });
