# pivot-scout

App para os operadores do **Pelican 2** registrarem a coordenada da **ponta externa do pivot**, que depois é lançada no **PlaneView**.

1. O operador vai até a ponta externa do pivot e captura a coordenada GPS no celular.
2. O ponto fica salvo no celular e é enviado sozinho quando há Wi-Fi ou dados móveis.
3. No PC, o painel mostra todos os pontos no mapa. Você copia o `lat, long` (ou exporta KML/GeoJSON) e lança no PlaneView.
4. O centro do pivot (mapa de gradiente) mais a ponta (este app) definem a posição e o comprimento do pivot.

## Páginas

| Página | Quem usa | Para quê |
| --- | --- | --- |
| `index.html` | Operador, no celular | Captura com GPS ao vivo, precisão em metros, nome obrigatório, foto opcional, funciona sem internet |
| `painel.html` | PC | Mapa de satélite, tabela, clique na lat/long para copiar, contagem de "apaga em", editar, apagar, exportar KML/GeoJSON, importar a área da fazenda (KML/KMZ) |
| `admin.html` | Administrador | Criar e revogar códigos de equipe, trocar token, trocar senha |
| `tools/setup.html` | Administrador, uma vez | Configuração inicial |

Endereço depois de publicado: `https://arcsxd.github.io/pivot-scout/`

## Como funciona (tudo no GitHub)

- **Este repositório (público)** guarda o código e é publicado pelo GitHub Pages.
- **`arcsxd/pivot-scout-data` (privado)** guarda os dados:
  - `points/<id>.json` com nome, lat, lng, precisão, data, equipe, operador e `uploaded_at`;
  - `photos/<id>.jpg` com a foto.
- O app grava nesse repo pela API do GitHub usando um **token**. O token nunca fica em texto puro no repo público:
  - `teams.json` tem o token criptografado (AES-GCM + PBKDF2) com cada **código de equipe**;
  - `admin.json` tem os tokens criptografados com a **senha de admin**.

## Configuração (uma vez)

1. **Crie o repo de dados**: em https://github.com/new, crie `pivot-scout-data`, marque **Private** e **Add a README**.
2. **Token de dados**: em https://github.com/settings/personal-access-tokens/new:
   - Repository access: *Only select repositories* → `pivot-scout-data`.
   - Permissions → Repository → **Contents: Read and write**.
   - Validade: a maior que fizer sentido (anote a data para renovar).
3. **Token de admin**: crie outro token igual, mas só para o repo `pivot-scout`.
4. **GitHub Pages**: em *Settings → Pages* do `pivot-scout`, escolha *Deploy from a branch*, branch `main`, pasta `/ (root)`.
5. Abra `https://arcsxd.github.io/pivot-scout/tools/setup.html`:
   - cole os dois tokens;
   - defina a senha de admin (mínimo 10 caracteres);
   - crie o primeiro código de equipe.
6. Espere cerca de 1 minuto. O Pages publica, e então o código funciona no celular.

Para criar mais códigos, use `admin.html`.

## Uso no celular

- Abra o endereço no Chrome (Android) ou Safari (iPhone) e permita a localização.
- No menu do navegador, use **Adicionar à tela inicial** para virar um "app".
- O primeiro login precisa de internet. Depois disso, a captura funciona offline.
- A precisão aparece em verde (≤5 m), amarelo (≤10 m) ou vermelho (>10 m). O GPS de celular costuma dar 3 a 10 m. Ficar parado alguns segundos ajuda.

## Área da fazenda (KML/KMZ)

No painel do PC, use **Fazendas → Importar KML / KMZ**. Serve um arquivo exportado do Google Earth, por exemplo.
- A área fica salva em `farms/` no repo de dados e aparece no mapa para todos.
- A coluna **Fazenda** da tabela mostra em qual fazenda (e talhão) cada ponto caiu. Essa informação também vai nas exportações.
- Polígonos com buracos e arquivos com vários talhões são suportados.

## Copiar coordenada

Clique (ou toque) em qualquer `lat, long`: na tabela, no balão do mapa, na lista do celular ou na posição atual do GPS. A coordenada é copiada no formato `-15.780123, -47.929234`.

## Pontos apagam sozinhos em 24 h

Cada ponto (e a foto) é apagado **24 h depois de chegar na nuvem** (`uploaded_at`). Um ponto capturado sem sinal ainda fica 24 h visível depois de enviado.

- **No repo de dados**, uma tarefa agendada do GitHub Actions roda a cada hora e apaga os pontos vencidos. Os arquivos ficam em `tools/data-repo/` e precisam ser copiados para o `pivot-scout-data`:
  - `.github/workflows/apagar-24h.yml`
  - `.github/scripts/apagar-24h.mjs`
- **O painel** esconde o ponto na hora exata e também apaga, caso a tarefa atrase.
- **O celular** tira da lista os pontos enviados há mais de 24 h.
- Repositório privado: cada execução usa cerca de 1 min do GitHub Actions, ou seja, ~720 min/mês, dentro dos 2000 min grátis.

## Quem está online (admin)

Em `admin.html`, o cartão **Quem está online** lista cada aparelho com:
- equipe e nome do operador (o operador digita o nome, opcional, no login do celular);
- se é o app de captura ou o painel do PC, e o sistema (Android, iPhone, Windows…);
- o status: **Online**, **Em segundo plano** ou **Offline**, e quando foi visto pela última vez;
- no celular: pontos pendentes de envio, precisão do GPS e a última captura.

Como funciona: celulares mandam um sinal a cada 1 min com o app aberto, e painéis a cada 2 min. Os sinais ficam em `presence/` na branch `presence` do repo de dados, separada para não poluir o histórico. O admin compacta essa branch a cada login.

## Segurança: o que saber

- Qualquer pessoa com um código válido consegue ler e gravar no repo de dados.
- **Revogar** um código impede logins novos com ele. Mas um celular que já entrou continua com o token. Se um código vazar:
  1. em `admin.html` → **Trocar token de dados**, cole um token novo;
  2. **apague o token antigo** no GitHub.
- Os arquivos `teams.json` e `admin.json` são públicos, mas criptografados. A segurança depende de a senha de admin ser forte. Os códigos de equipe são gerados aleatoriamente.
- Os tokens fine-grained expiram. Quando expirarem, gere novos e use "Trocar token de dados".

## Desenvolvimento

Sem build: HTML, CSS e JS puro (módulos ES). O Leaflet está em `vendor/`.

```bash
npm test
```

```bash
npm run e2e
```

O `npm run e2e` usa Playwright com uma API do GitHub simulada, e as screenshots vão para `screenshots/`.

Para rodar localmente, use `npm run serve` e abra `http://localhost:8080`. O GPS no navegador exige `localhost` ou HTTPS.

Ao publicar mudanças, aumente `VERSION` em `sw.js` para os celulares baixarem a versão nova.
