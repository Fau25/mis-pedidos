// Mis pedidos · service worker
const CACHE = 'mis-pedidos-v7';
const FUENTES = 'mis-pedidos-fuentes';
const BASE = ['./', 'index.html', 'manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== FUENTES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // La tipografía se guarda para que se vea igual sin conexión
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FUENTES).then(async c => {
      const copia = await c.match(e.request);
      if (copia) return copia;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    }));
    return;
  }

  if (url.origin !== location.origin) return; // el script de Google va siempre a la red

  // Red primero (como mucho 1,5 s) y si no hay, la copia guardada
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const red = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; });
      const copia = await cache.match(e.request, { ignoreSearch: true });
      if (!copia) return await red;
      return await Promise.race([red, new Promise(res => setTimeout(() => res(copia), 1500))]);
    } catch (err) {
      return (await cache.match(e.request, { ignoreSearch: true })) || (await cache.match('index.html'));
    }
  })());
});
