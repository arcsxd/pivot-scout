// Service worker: deixa o app abrir sem internet.
// Ao publicar mudanças, aumente VERSION para os celulares pegarem a versão nova.
const VERSION = 'ps-v4';
const SHELL = [
  './',
  'index.html',
  'painel.html',
  'admin.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'js/admin.js',
  'js/adminlib.js',
  'js/auth.js',
  'js/capture.js',
  'js/config.js',
  'js/crypto.js',
  'js/export.js',
  'js/geo.js',
  'js/github.js',
  'js/i18n.js',
  'js/kml.js',
  'js/painel.js',
  'js/store.js',
  'js/sync.js',
  'js/ui.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API do GitHub e mapas: sempre direto na rede.
  if (url.origin !== self.location.origin) return;

  // teams.json / admin.json: rede primeiro, cache se estiver sem internet.
  if (url.pathname.endsWith('.json')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(() => caches.match(url.pathname)),
    );
    return;
  }

  // Demais arquivos: responde do cache e atualiza em segundo plano.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    }),
  );
});
