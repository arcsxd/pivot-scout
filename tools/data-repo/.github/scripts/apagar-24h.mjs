// Remove pontos com mais de 24 h desde que chegaram na nuvem (uploaded_at),
// ou desde a captura para pontos antigos sem esse campo. Remove a foto junto.
// Deixa as remoções no índice do git (git rm); o workflow faz o commit.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TTL_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const dir = 'points';
const gone = [];

if (existsSync(dir)) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const path = `${dir}/${file}`;
    let rec;
    try {
      rec = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue; // arquivo estranho: não mexe
    }
    const base = Date.parse(rec.uploaded_at || rec.captured_at);
    if (!Number.isFinite(base) || now < base + TTL_MS) continue;
    const paths = [path];
    const photo = rec.photo || `photos/${rec.id}.jpg`;
    if (existsSync(photo)) paths.push(photo);
    execFileSync('git', ['rm', '-q', '--', ...paths]);
    gone.push(rec.name || rec.id);
  }
}

console.log(gone.length ? `Apagados ${gone.length}: ${gone.join(', ')}` : 'Nenhum ponto vencido.');
