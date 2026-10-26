const CACHE_NAME = 'bh-finance-v37';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/logo.jpg',
  './js/firebase-config.js',
  './js/firebase-service.js',
  // Firebase SDK (cached for offline use — app degrades gracefully if missing)
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;800;900&display=swap'
];

// Install event - Cache static assets (bypass HTTP cache to always get fresh files)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Caching app shell');
      return Promise.all(
        ASSETS.map((url) =>
          // `cache: 'reload'` forces a fresh network fetch, ignoring the HTTP cache
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[ServiceWorker] Failed to cache:', url, err);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// Activate event - Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[ServiceWorker] Removing old cache', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - Cache first with Network fallback
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Revalidate in background ONLY for page navigations (HTML).
        // Static assets (css/js/icons) stay cache-first — no wasted network calls on every launch.
        if (event.request.mode === 'navigate') {
          fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
              }
            })
            .catch(() => {/* Offline mode */});
        }
        return cachedResponse;
      }

      // Fetch from network if not in cache
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      }).catch(() => {
        // Return fallback html if offline navigation
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ─── Notification click → open/focus the app ─────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});

// ─── Message from app page ───────────────────────────────────
// Supports action: 'SCHEDULE_SMART_ALERT'
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.action === 'SCHEDULE_SMART_ALERT') {
    const { timestamp, title, body, tag } = event.data;
    scheduleSmartAlert(timestamp, title, body, tag);
  }
});

/**
 * Schedule a smart alert notification for a future time.
 * Uses the Notification Triggers API when available (works when the app is closed).
 */
async function scheduleSmartAlert(timestamp, title, body, tag) {
  if (!('showNotification' in self.registration)) return;
  try { await cancelSmartAlerts(); } catch (e) { /* non-critical */ }

  const delay = timestamp - Date.now();
  if (delay < 0) return;

  const options = {
    body: body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: tag || 'bh-smart-alert',
    requireInteraction: false,
    data: { url: './' }
  };

  try {
    if (typeof TimestampTrigger !== 'undefined') {
      options.showTrigger = new TimestampTrigger(timestamp);
      await self.registration.showNotification(title || 'بوني', options);
    } else {
      // Fallback: show it now if we can't schedule (still useful info)
      await self.registration.showNotification(title || 'بوني', options);
    }
  } catch (err) {
    console.warn('[SW] Could not schedule smart alert:', err);
  }
}

async function cancelSmartAlerts() {
  try {
    if (!('getNotifications' in self.registration)) return;
    const all = await self.registration.getNotifications();
    for (const n of all) {
      if (n.tag && n.tag.startsWith('bh-smart')) n.close();
    }
  } catch (e) { /* non-critical */ }
}

/**
 * Real push messages (Firebase Cloud Messaging / Web Push).
 * Ready for a Cloud Function or any server that can send FCM web pushes.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'بوني', body: event.data ? event.data.text() : 'لديك إشعار جديد' };
  }

  const title = payload.title || 'بوني';
  const options = {
    body: payload.body || '',
    icon: payload.icon || './icon-192.png',
    badge: './icon-192.png',
    tag: payload.tag || 'bh-push',
    data: { url: payload.url || './' },
    requireInteraction: !!payload.requireInteraction
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

