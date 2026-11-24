import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptJSON, decryptJSON, formatCode, parseCode, randomString, generateTeamId } from '../js/crypto.js';
import { toKML, toGeoJSON, formatLatLng } from '../js/export.js';
import { utf8ToB64, b64ToUtf8 } from '../js/github.js';
import { buildTeam, reencryptTeams } from '../js/adminlib.js';

test('criptografa e descriptografa com a senha certa', async () => {
  const blob = await encryptJSON({ data_token: 'github_pat_x', n: 1 }, 'senha-forte-123');
  assert.deepEqual(await decryptJSON(blob, 'senha-forte-123'), { data_token: 'github_pat_x', n: 1 });
  assert.equal(await decryptJSON(blob, 'errada'), null);
  assert.ok(!JSON.stringify(blob).includes('github_pat_x'));
});

test('código de equipe: formatar e interpretar', () => {
  const secret = randomString(10);
  assert.match(secret, /^[A-HJKMNP-Z2-9]{10}$/);
  const code = formatCode('K7Q', secret);
  assert.equal(code, `K7Q-${secret.slice(0, 5)}-${secret.slice(5)}`);
  assert.deepEqual(parseCode(code.toLowerCase()), { id: 'K7Q', secret });
  assert.deepEqual(parseCode(` k7q - ${secret.slice(0, 5)} ${secret.slice(5)} `.replace(/ - /, '-')), { id: 'K7Q', secret });
  assert.equal(parseCode('semtraco'), null);
  assert.equal(parseCode(''), null);
});

test('generateTeamId evita ids existentes', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(generateTeamId([...ids]));
  assert.equal(ids.size, 200);
});

test('buildTeam gera time que abre com o código', async () => {
  const { team, code } = await buildTeam('Equipe Norte', 'tok-1', []);
  const { secret } = parseCode(code);
  assert.equal(team.label, 'Equipe Norte');
  assert.deepEqual(await decryptJSON(team.enc, secret), { data_token: 'tok-1', team_id: team.id, label: 'Equipe Norte' });

  const { teams, missing } = await reencryptTeams([team], { [team.id]: code }, 'tok-2');
  assert.deepEqual(missing, []);
  assert.equal((await decryptJSON(teams[0].enc, secret)).data_token, 'tok-2');
});

test('base64 UTF-8 ida e volta', () => {
  const s = 'Pivô 12 – Fazenda São João ✓';
  assert.equal(b64ToUtf8(utf8ToB64(s)), s);
});

const pts = [
  { id: 'a', name: 'Pivot <1> & "Sul"', lat: -15.1234567, lng: -47.7654321, accuracy_m: 4.2, captured_at: '2026-11-24T12:00:00.000Z', team_label: 'Norte', status: 'pendente' },
  { id: 'b', name: 'Pivot 2', lat: -15.2, lng: -47.8, accuracy_m: 12, status: 'lancado' },
];

test('GeoJSON usa [lng, lat]', () => {
  const g = toGeoJSON(pts);
  assert.equal(g.type, 'FeatureCollection');
  assert.deepEqual(g.features[0].geometry.coordinates, [-47.7654321, -15.1234567]);
  assert.equal(g.features[1].properties.status, 'lancado');
});

test('KML é XML válido e escapa nomes', () => {
  const kml = toKML(pts);
  assert.match(kml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.ok(kml.includes('<name>Pivot &lt;1&gt; &amp; &quot;Sul&quot;</name>'));
  assert.ok(kml.includes('<coordinates>-47.7654321,-15.1234567,0</coordinates>'));
  assert.equal((kml.match(/<Placemark>/g) || []).length, 2);
});

test('formatLatLng com 6 casas', () => {
  assert.equal(formatLatLng(-15.1234567, -47.7654321), '-15.123457, -47.765432');
});
