const CACHE_NAME = 'bh-finance-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
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

// ─── Smart Alarm: Notification click → open/focus the app ───
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.notification.tag && event.notification.tag.startsWith('bh-alarm')) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow('./');
      })
    );
  }
});

// ─── Smart Alarm: Message from app page ─────────────────────
// Supports actions: 'SCHEDULE_ALARM' and 'CANCEL_ALARM'
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.action === 'SCHEDULE_ALARM') {
    const { timestamps, reason, title } = event.data;
    scheduleAlarmNotifications(timestamps, reason, title);
  }

  if (event.data.action === 'CANCEL_ALARM') {
    cancelScheduledAlarms();
  }
});

/**
 * Schedule notifications using Notification Triggers API (works when app is closed).
 * Falls back gracefully if the API is unavailable.
 */
async function scheduleAlarmNotifications(timestamps, reason, title) {
  // Cancel any previous scheduled alarms first
  await cancelScheduledAlarms();

  if (!('showNotification' in self.registration)) return;

  // Check if Notification Triggers API is supported
  const supportsTimestampTrigger = typeof TimestampTrigger !== 'undefined';

  for (const ts of timestamps) {
    const delay = ts - Date.now();
    if (delay < 0) continue; // skip past times

    try {
      const options = {
        body: reason,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: `bh-alarm-${ts}`,
        requireInteraction: true,
        data: { url: './' }
      };

      if (supportsTimestampTrigger) {
        // Schedule to fire even when app is closed
        options.showTrigger = new TimestampTrigger(ts);
      }

      await self.registration.showNotification(title || '⏰ BH — منبه ذكي', options);
    } catch (err) {
      console.warn('[SW] Could not schedule alarm notification:', err);
    }
  }

  // Store scheduled timestamps in cache for reference
  try {
    const cache = await caches.open('bh-alarm-meta');
    await cache.put('/bh-alarm-timestamps', new Response(JSON.stringify(timestamps)));
  } catch (e) {/* non-critical */}
}

/**
 * Cancel all previously scheduled alarm notifications
 */
async function cancelScheduledAlarms() {
  try {
    if (!('getNotifications' in self.registration)) return;
    const notifications = await self.registration.getNotifications({ tag: 'bh-alarm' });
    // Also get all bh-alarm-* tagged notifications
    const all = await self.registration.getNotifications();
    for (const n of all) {
      if (n.tag && n.tag.startsWith('bh-alarm')) {
        n.close();
      }
    }
  } catch (e) {
    console.warn('[SW] Could not cancel alarm notifications:', e);
  }
}
