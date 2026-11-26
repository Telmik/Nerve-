const CACHE_PREFIX = 'nerve-pwa-';
// Match the release number shown in Settings.
const CACHE_NAME = CACHE_PREFIX + 'v1.5.0';
const CORE_ASSETS = new Set([
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icons/nerve-192.png',
  './cloud-sync.js',
  './cloud-config.js'
].map(path => new URL(path, self.location.href).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...CORE_ASSETS].map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const oldCaches = keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    await Promise.all(oldCaches.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const cacheKey = new URL(event.request.url);
  cacheKey.search = '';
  if (!CORE_ASSETS.has(cacheKey.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    let response;
    try {
      response = await fetch(event.request, { cache: 'no-cache' });
    } catch {
      return (await cache.match(cacheKey.href)) || Response.error();
    }
    if (response.ok) {
      try { await cache.put(cacheKey.href, response.clone()); } catch {}
    }
    return response;
  })());
});
