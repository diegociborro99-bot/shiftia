// Shiftia Service Worker v3.2
// Offline cache — network-first for HTML, cache-first for static assets

const CACHE_NAME = 'shiftia-v3.2';
const STATIC_ASSETS = [
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
];

// Install — cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip WebSocket
  if (url.pathname === '/ws') return;

  // API calls: network-only (localStorage handles offline)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        if (url.pathname === '/api/data' && event.request.method === 'GET') {
          return new Response(JSON.stringify({}), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        // POST /api/data offline — return success (localStorage already saved)
        if (url.pathname === '/api/data' && event.request.method === 'POST') {
          return new Response(JSON.stringify({ success: true, offline: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // HTML navigation: network-first (always get latest deploy)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        return caches.match(event.request).then(cached => cached || caches.match('/index.html'));
      })
    );
    return;
  }

  // Other static assets: cache-first, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => null);
    })
  );
});
