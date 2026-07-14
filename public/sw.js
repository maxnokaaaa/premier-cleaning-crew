// Service worker — receives push notifications and shows them, even when the
// app tab is closed (on Android; on iOS the app must be added to the Home Screen).
self.addEventListener('push', (event) => {
  let data = { title: 'Premier Cleaning', body: 'Open the app.', url: '/' };
  try { data = { ...data, ...event.data.json() }; } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'crew-clock',
      renotify: true,
      requireInteraction: false,
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
