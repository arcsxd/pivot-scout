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
| `painel.html` | PC | Mapa de satélite, tabela, clique na lat/long para copiar, marcar "lançado no PlaneView", editar, apagar, exportar KML/GeoJSON, importar a área da fazenda (KML/KMZ) |
| `admin.html` | Administrador | Criar e revogar códigos de equipe, trocar token, trocar senha |
| `tools/setup.html` | Administrador, uma vez | Configuração inicial |

Endereço depois de publicado: `https://arcsxd.github.io/pivot-scout/`

## Como funciona (tudo no GitHub)

- **Este repositório (público)** guarda o código e é publicado pelo GitHub Pages.
- **`arcsxd/pivot-scout-data` (privado)** guarda os dados:
  - `points/<id>.json` com nome, lat, lng, precisão, data, equipe e status;
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
