// This worker serves the older Nerve at the root of GitHub Pages.
const CACHE_NAME = 'nerve-offline:' + encodeURIComponent(self.registration.scope) + ':v1';
const CORE_ASSETS = new Set([
  './', './index.html', './manifest.json', './icon.svg'
].map(path => new URL(path, self.location.href).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...CORE_ASSETS].map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
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
    if (response.status >= 500) {
      return (await cache.match(cacheKey.href)) || response;
    }
    if (response.ok) {
      try { await cache.put(cacheKey.href, response.clone()); } catch {}
    }
    return response;
  })());
});
