// Web push service worker: shows one notification per push message and opens
// the inbox on click. Payload: { title, body, url } JSON.
self.addEventListener('push', (event) => {
  let data = { title: 'DRepTalk', body: 'New notifications', url: '/notifications/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    // Keep defaults on an unparseable payload.
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/favicon.png',
    data: { url: data.url },
    tag: 'dreptalk', // successive summaries replace the previous one instead of piling up
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/notifications/'));
});
