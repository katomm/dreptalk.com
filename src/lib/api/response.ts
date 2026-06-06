// Shared helpers for API route handlers.
import { env as workersEnv } from 'cloudflare:workers';

/**
 * Builds a JSON Response with the correct content-type header.
 * Optional extra headers are merged after content-type.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/**
 * Returns the Cloudflare runtime environment bindings (D1, KV, vars).
 *
 * Adapter 13 / Astro 6 removed `Astro.locals.runtime.env`; the bindings are now
 * exposed as a module global via `cloudflare:workers`. The `locals` argument is
 * accepted for call-site compatibility but is no longer read.
 */
export function runtimeEnv(_locals?: App.Locals): Record<string, unknown> {
  return (workersEnv ?? {}) as unknown as Record<string, unknown>;
}
