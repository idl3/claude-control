/* claude-control service worker — Web Push only. Dependency-free.
 * Copied verbatim into web/dist by Vite (lives in web/public). Served at /sw.js.
 */

// Activate immediately on update so a stale SW never lingers on the phone.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A Claude session raised an AskUserQuestion → show a notification even when the
// app tab is closed. Payload shape: { title, body, data:{ id } }.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = { title: 'Claude Control', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Claude Control';
  const options = {
    body: payload.body || 'A session needs your input.',
    data: payload.data || {},
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.data && payload.data.id ? `ask-${payload.data.id}` : 'claude-control',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an open tab (passing the session id along) or
// opens the app fresh.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            if (id) {
              try {
                client.postMessage({ type: 'open-session', id });
              } catch (_e) {
                /* ignore */
              }
            }
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow('/');
        }
        return undefined;
      }),
  );
});
