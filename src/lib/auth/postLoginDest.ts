// Where a successful login goes. By default the signed-in start page; a page
// that sends someone to /login/ for a purpose (subscribing to notifications,
// say) passes ?next=<path> so the visitor comes back to it. Only same-site
// paths are followed, so the parameter can never turn the login page into a
// redirect to somewhere else.

/** The start page after a login without a (valid) next parameter. */
export const DEFAULT_POST_LOGIN_DEST = '/home/';

/**
 * The next parameter when it is a same-site absolute path, else null. Rejects
 * protocol-relative forms (`//host`, `/\host`, which browsers treat alike),
 * schemes, relative paths, control characters and a loop back to /login/.
 */
export function safeNextPath(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  // A backslash anywhere (browsers read `/\host` as `//host`) or a control
  // character, raw or percent-encoded, is never part of a path we link to.
  if (raw.includes('\\') || [...raw].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null;
  if (/%(0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(raw)) return null;
  if (/^\/login(\/|\?|#|$)/.test(raw)) return null;
  return raw;
}

/** The destination for a login that happened on a page with this query string. */
export function postLoginDest(search: string): string {
  return safeNextPath(new URLSearchParams(search).get('next')) ?? DEFAULT_POST_LOGIN_DEST;
}

/** A /login/ link that returns to `next` afterwards. */
export function loginHref(next: string): string {
  return `/login/?next=${encodeURIComponent(next)}`;
}
