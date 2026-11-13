/* Service Worker — shell offline, cache de fotos e Background Sync. */
importScripts('/db.js');

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;
const TAILWIND = 'https://cdn.tailwindcss.com';
const SHELL = ['/', '/index.html', '/app.js', '/db.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    try { await cache.put(TAILWIND, await fetch(TAILWIND, { mode: 'no-cors' })); } catch (_) { /* tenta de novo no 1º uso */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL_CACHE, RUNTIME_CACHE].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.href.startsWith(TAILWIND)) {                       // CDN do Tailwind: cache primeiro
    e.respondWith((async () => {
      const hit = await caches.match(TAILWIND) || await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      (await caches.open(SHELL_CACHE)).put(TAILWIND, res.clone());
      return res;
    })());
    return;
  }
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith('/api/photos/')) {             // fotos: imutáveis (nome = UUID)
    e.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  if (url.pathname.startsWith('/api/')) return;              // dados: sempre rede (o app trata offline)

  if (req.mode === 'navigate') {                             // páginas: rede primeiro, shell como fallback
    e.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith((async () => {                               // estáticos: stale-while-revalidate
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })());
});

// Background Sync (Chrome/Android): dispara quando a conexão volta, mesmo com o app fechado.
self.addEventListener('sync', e => {
  if (e.tag === 'sync-queue') e.waitUntil(DB.sync());
});

self.addEventListener('message', e => {
  if (e.data === 'SYNC_NOW') e.waitUntil(DB.sync());
});
