// Web push service worker, registered at scope '/'. Shows one notification per
// push message and opens the inbox on click. Payload: { title, body, url } JSON.
//
// This is the ONLY service worker on the site and it owns the root scope. Do not
// add a second service worker or a fetch handler for PWA/offline support: a
// second worker registered at '/' would take over this scope and can break Web
// Push. Any future offline caching must be added to THIS file and must preserve
// the push and notificationclick handlers below, caching only versioned static
// assets, never SSR pages, session responses, or /api/* routes.
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
