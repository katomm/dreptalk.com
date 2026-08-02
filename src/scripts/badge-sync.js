// Inlined into <head> via set:html in Layout.astro (mirrors theme-init.js), so
// its SHA-256 is pinned in astro.config.mjs under the strict CSP. Keeps the PWA
// app-icon badge (Badging API) in step with the header bell: the unread count
// rides in on <html data-notif-unread>, rendered only while signed in.
//
// When the attribute is absent (signed out, or an anonymous page) the badge is
// cleared, so it never sticks after sign-out or after the inbox was read on
// another device. Push updates the badge separately from the service worker
// while the app is closed; this render-time sync is the source of truth once the
// app is open, since it reads the same count getUnreadCount feeds the bell.
(() => {
  if (!('setAppBadge' in navigator)) return;
  const raw = document.documentElement.dataset.notifUnread;
  const count = raw ? Number.parseInt(raw, 10) : 0;
  // A rejected promise (permission not yet granted, unsupported surface) is
  // harmless here, so swallow it rather than surfacing an unhandled rejection.
  if (Number.isFinite(count) && count > 0) {
    navigator.setAppBadge(count).catch(() => {});
  } else {
    navigator.clearAppBadge().catch(() => {});
  }
})();
