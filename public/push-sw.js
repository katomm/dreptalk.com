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
    // Tagged per destination, not with one shared tag: repeated inbox summaries
    // still collapse into a single entry (they are cumulative, so the newest
    // supersedes), while messages about different items keep their own entry.
    // A shared tag would drop an unread item-level message, and its deep link
    // with it, as soon as an unrelated one arrived; the dispatcher advances its
    // cursor on send, so that message is never repeated.
    tag: `dreptalk:${data.url}`,
    // A replacement is otherwise silent, so a superseded summary would never
    // re-alert about what it added.
    renotify: true,
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/notifications/'));
});
