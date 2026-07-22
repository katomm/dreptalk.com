/// <reference types="@cloudflare/workers-types" />
// Request-scoped loader for the signed-in header data: resolved identity plus
// the bell's unread count. The layout needs the pair on every signed-in render
// and /home/ needs the same pair for its greeting and notifications card;
// memoizing the promise on Astro.locals lets a page and its layout share one
// set of D1 queries per request instead of each paying their own.

import { runtimeEnv } from '../api/response.js';
import { getUnreadCount } from '../db/notifications.js';
import { loadAuthorIdentity, type AuthorDescriptor } from './author.js';

/** Identity + unread count for the signed-in user, memoized per request. */
export function loadSessionHeader(
  locals: App.Locals,
  userId: string,
): Promise<[AuthorDescriptor, number]> {
  if (!locals.sessionHeader) {
    const env = runtimeEnv(locals);
    locals.sessionHeader = Promise.all([
      loadAuthorIdentity(env.DB, userId),
      getUnreadCount(env.DB, userId),
    ]);
  }
  return locals.sessionHeader;
}
