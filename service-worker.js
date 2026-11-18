/* Rabatghash Kingdom Web Push service worker */
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'المملكة الربطخشاوية';
  const options = {
    body: payload.body || 'لديك رسالة جديدة',
    icon: '/assets/logo/logo.png',
    badge: '/assets/logo/logo.png',
    tag: `rabatghash-${payload.chatType || 'chat'}`,
    renotify: true,
    data: { url: payload.url || '/', chatType: payload.chatType || 'public' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
