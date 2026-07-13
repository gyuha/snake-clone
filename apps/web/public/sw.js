// Same-origin app shell only. API and WebSocket requests are intentionally not
// intercepted: cached game/auth responses would be unsafe and stale.
// assets-manifest.json version과 반드시 같아야 한다. check:assets가 이를 검증한다.
const CACHE = 'serpent-arena-shell-2026-07-14.1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/assets-manifest.json', '/icons/serpent.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
      return response;
    }).catch(() => caches.match('/index.html')));
    return;
  }

  if (!['script', 'style', 'image', 'font'].includes(request.destination)) return;
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  })));
});
