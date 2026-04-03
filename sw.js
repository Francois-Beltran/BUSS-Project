const CACHE_NAME = 'buss-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

/**
 * 1. INSTALLATION: Pre-cache static UI assets
 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching offline assets...');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

/**
 * 2. ACTIVATION: Clean up old caches
 */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  return self.clients.claim();
});

/**
 * 3. FETCH: Intercept requests for "Stale-While-Revalidate"
 * This keeps the app feeling snappy while updating the cache in the background.
 */
self.addEventListener('fetch', event => {
  // We only cache GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        // If it's a valid network response, cache it (including map tiles)
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Silently fail fetch if offline
      });

      return cachedResponse || fetchPromise;
    })
  );
});

/**
 * 4. PWA DATA BRIDGE (Heartbeat)
 * Acts as a listener for coordinate updates from the main thread
 * to help maintain persistent lifecycle state.
 */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'HEARTBEAT') {
    // Service worker is acknowledged and stays alive
    // In a more complex app, we could store these coordinates in IndexedDB here
  }
});
