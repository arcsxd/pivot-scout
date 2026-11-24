import { $ } from '../js/ui.js';
import { siteRepo } from '../js/auth.js';
import { buildTeam, checkDataToken, writeConfig, MIN_ADMIN_PASSWORD } from '../js/adminlib.js';
import { DATA_OWNER, DATA_REPO, SITE_OWNER, SITE_REPO } from '../js/config.js';

$('#data-repo').textContent = `${DATA_OWNER}/${DATA_REPO}`;
$('#site-repo').textContent = `${SITE_OWNER}/${SITE_REPO}`;

$('#setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#err');
  const btn = $('#setup button');
  err.textContent = '';
  const dataToken = $('#data-token').value.trim();
  const siteToken = $('#site-token').value.trim();
  const pw = $('#pw1').value;
  if (pw.length < MIN_ADMIN_PASSWORD) return (err.textContent = `A senha precisa ter pelo menos ${MIN_ADMIN_PASSWORD} caracteres.`);
  if (pw !== $('#pw2').value) return (err.textContent = 'As senhas não conferem.');

  btn.disabled = true;
  btn.textContent = 'Testando…';
  try {
    let step = 'token de dados';
    try {
      const { private: isPrivate } = await checkDataToken(dataToken);
      if (!isPrivate && !confirm(`O repo ${DATA_OWNER}/${DATA_REPO} é PÚBLICO: qualquer pessoa verá as coordenadas e fotos. Continuar?`)) return;
      step = 'token de admin';
      const site = siteRepo(siteToken);
      await site.repoInfo();
      const existing = await site.getFile('admin.json');
      if (existing && !$('#overwrite').checked) {
        $('#overwrite-wrap').hidden = false;
        err.textContent = 'Já existe admin.json. Marque a opção para substituir ou use a página de admin.';
        return;
      }
      btn.textContent = 'Gravando…';
      const label = $('#first-team').value.trim();
      const teams = [];
      const codes = {};
      let firstCode = null;
      if (label) {
        const { team, code } = await buildTeam(label, dataToken, []);
        teams.push(team);
        codes[team.id] = code;
        firstCode = code;
      }
      await writeConfig(site, teams, { admin_token: siteToken, data_token: dataToken, codes }, pw, 'Configuração inicial do Pivot Scout');
      $('#setup').closest('section').hidden = true;
      $('#done').hidden = false;
      if (firstCode) {
        $('#first-code-value').textContent = firstCode;
        $('#first-code').hidden = false;
      }
    } catch (e2) {
      const hint = e2.status === 404 ? ' (repositório não encontrado ou token sem acesso a ele)' : e2.status === 401 ? ' (token inválido)' : e2.status === 403 ? ' (token sem permissão de escrita)' : '';
      err.textContent = `Falha no ${step}: ${e2.message}${hint}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Testar e salvar';
  }
});
