// Web push service worker, registered at scope '/'. Shows one notification per
// push message, mirrors the unread count onto the app-icon badge, and opens the
// inbox on click. Payload: { title, body, url, badge? } JSON.
//
// This is the ONLY service worker on the site and it owns the root scope. Do not
// add a second service worker or a fetch handler for PWA/offline support: a
// second worker registered at '/' would take over this scope and can break Web
// Push. Any future offline caching must be added to THIS file and must preserve
// the push and notificationclick handlers below, caching only versioned static
// assets, never SSR pages, session responses, or /api/* routes.
self.addEventListener('push', (event) => {
  // Title names the subject, never the app: the OS already shows "DRepTalk" in
  // the notification header (and a "from DRepTalk" line on iOS), so repeating it
  // as the title is pure redundancy. This default only shows on an unparseable
  // payload; the real title/body come from the dispatcher (see dispatch.ts).
  let data = { title: 'New activity', body: 'You have new notifications', url: '/notifications/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    // Keep defaults on an unparseable payload.
  }
  const tasks = [
    self.registration.showNotification(data.title, {
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
    }),
  ];
  // Set the app-icon badge to the unread count the dispatcher put in the payload,
  // so the installed app shows the same number the header bell does even while
  // closed. setAppBadge is exposed on the worker navigator too; opening the app
  // re-syncs (or clears) the badge from the rendered count. Ignore a rejection
  // (unsupported platform or the notification permission was revoked).
  if (typeof data.badge === 'number' && 'setAppBadge' in navigator) {
    tasks.push(navigator.setAppBadge(data.badge).catch(() => {}));
  }
  event.waitUntil(Promise.all(tasks));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/notifications/';
  // Reuse an already-open app window: focus it and navigate to the target,
  // instead of opening one new window per clicked notification (in the
  // installed app those pile up as separate windows). matchAll returns the
  // most recently focused window first.
  event.waitUntil(
    (async () => {
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins[0];
      if (!win) return clients.openWindow(url);
      await win.focus().catch(() => {});
      try {
        // navigate() rejects for windows this worker does not control yet
        // (a tab opened before the worker activated). Open a fresh one then.
        return await win.navigate(url);
      } catch {
        return clients.openWindow(url);
      }
    })(),
  );
});
