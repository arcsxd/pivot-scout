// Montagem e gravação de teams.json / admin.json (usado pelo admin e pelo setup).
import { encryptJSON, formatCode, generateTeamId, randomString } from './crypto.js';
import { GitHub } from './github.js';
import { DATA_OWNER, DATA_REPO } from './config.js';

export const MIN_ADMIN_PASSWORD = 10;

export async function buildTeam(label, dataToken, existingIds) {
  const id = generateTeamId(existingIds);
  const secret = randomString(10);
  const code = formatCode(id, secret);
  const enc = await encryptJSON({ data_token: dataToken, team_id: id, label }, secret);
  return { team: { id, label, created_at: new Date().toISOString(), enc }, code };
}

/** Recriptografa todos os times com um novo token de dados. */
export async function reencryptTeams(teams, codes, dataToken) {
  const out = [];
  const missing = [];
  for (const tm of teams) {
    const code = codes[tm.id];
    if (!code) {
      missing.push(tm.label);
      out.push(tm);
      continue;
    }
    const secret = code.split('-').slice(1).join('');
    out.push({ ...tm, enc: await encryptJSON({ data_token: dataToken, team_id: tm.id, label: tm.label }, secret) });
  }
  return { teams: out, missing };
}

/**
 * Grava teams.json e admin.json num único commit no repo do site.
 * payload = { admin_token, data_token, codes }
 */
export async function writeConfig(siteGH, teams, payload, password, message) {
  const teamsJson = { version: 1, teams };
  const adminJson = { version: 1, enc: await encryptJSON(payload, password) };
  await siteGH.commitFiles(
    [
      { path: 'teams.json', content: JSON.stringify(teamsJson, null, 2) + '\n' },
      { path: 'admin.json', content: JSON.stringify(adminJson, null, 2) + '\n' },
    ],
    message,
  );
}

/** Confere se o token tem leitura e escrita no repo de dados. */
export async function checkDataToken(token) {
  const gh = new GitHub({ token, owner: DATA_OWNER, repo: DATA_REPO });
  const info = await gh.repoInfo();
  const keep = await gh.getFile('points/.keep');
  if (!keep) await gh.putFile('points/.keep', 'Cg==', 'Cria pasta points');
  return { private: !!info.private };
}
