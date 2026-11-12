// Request-scoped D1 handle. Anonymous page reads run through a D1 session so
// they can be served by a nearby read replica once replication is enabled on
// the database. Everything else (signed-in users, writes, polled endpoints,
// crons) keeps the plain binding, which always goes to the primary. While
// replication is disabled, a session behaves exactly like the binding.
//
// requestDb() is the accessor for request code. runtimeEnv().DB resolves to
// the same handle for the older call sites.
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { hasSessionCookie } from '@/lib/auth/session.js';

const store = new AsyncLocalStorage<D1Database>();

/** The plain binding, which always reaches the primary. */
function binding(): D1Database | undefined {
  return (env as { DB?: D1Database } | undefined)?.DB;
}

/**
 * Paths an anonymous visitor polls right after a write elsewhere created the
 * row: a just-shared multisig vote, a just-submitted governance action. A
 * lagging replica would answer "not found" there, so they stay on the primary.
 */
const PRIMARY_ONLY_PREFIXES = ['/api/drep/multisig', '/api/gov-action/status'];

/**
 * True when a request may read from a replica: an anonymous GET or HEAD
 * outside the primary-only paths. Signed-in users must see their own writes at
 * once, and every other method either writes or reads around a write.
 */
export function mayReadFromReplica(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (hasSessionCookie(request)) return false;
  const { pathname } = new URL(request.url);
  return !PRIMARY_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Runs fn with the D1 handle this request should use: a fresh unconstrained
 * session when it may read from a replica, the plain binding otherwise. A
 * session offers prepare and batch like the binding, which is all request
 * code uses, so it is handed out under the binding's type. This cast is the
 * only place that relies on that.
 */
export function runWithRequestDb<T>(request: Request, fn: () => T): T {
  const db = binding();
  if (!db) return fn();
  const handle = mayReadFromReplica(request)
    ? (db.withSession('first-unconstrained') as unknown as D1Database)
    : db;
  return store.run(handle, fn);
}

/**
 * The current request's D1 handle, or the plain binding outside a request scope
 * (crons, tests, work deferred past the response).
 */
export function requestDb(): D1Database | undefined {
  return store.getStore() ?? binding();
}
