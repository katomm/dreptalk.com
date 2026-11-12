// Request-scoped D1 handle. Anonymous page reads run through a D1 session so
// they can be served by a nearby read replica once replication is enabled on
// the database. Everything else (signed-in users, writes, polled endpoints,
// crons) keeps the plain binding, which always goes to the primary. While
// replication is disabled, a session behaves exactly like the binding.
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { parseSessionToken } from '@/lib/auth/session.js';

const store = new AsyncLocalStorage<D1Database>();

/**
 * Paths an anonymous visitor polls right after a write elsewhere created the
 * row: a just-shared multisig vote, a just-submitted governance action. A
 * lagging replica would answer "not found" there, so they stay on the primary.
 */
const PRIMARY_ONLY_PREFIXES = ['/api/drep/multisig/', '/api/gov-action/status'];

/**
 * True when a request may read from a replica: a GET or HEAD without a session
 * cookie (the same test the page cache uses) outside the primary-only paths.
 * Signed-in users must see their own writes at once, and every other method
 * either writes or reads around a write.
 */
export function mayReadFromReplica(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (parseSessionToken(request.headers.get('Cookie')) !== null) return false;
  const { pathname } = new URL(request.url);
  return !PRIMARY_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * The D1 handle one request should use: a fresh unconstrained session when it
 * may read from a replica, the plain binding otherwise. A session offers
 * prepare and batch like the binding, which is all request code uses, so it is
 * handed out under the binding's type. This cast is the only place that
 * relies on that.
 */
export function openRequestDb(binding: D1Database | undefined, request: Request): D1Database | undefined {
  if (!binding || !mayReadFromReplica(request)) return binding;
  return binding.withSession('first-unconstrained') as unknown as D1Database;
}

/** Runs fn with handle as the request's D1 handle. Without a handle, fn just runs. */
export function runWithDb<T>(handle: D1Database | undefined, fn: () => T): T {
  return handle ? store.run(handle, fn) : fn();
}

/**
 * The current request's D1 handle, or the plain binding outside a request scope
 * (crons, tests, work deferred past the response).
 */
export function requestDb(): D1Database | undefined {
  return store.getStore() ?? (env as { DB?: D1Database } | undefined)?.DB;
}
