// Shared helpers for API route handlers.
import { env as workersEnv } from 'cloudflare:workers';
import { networkFromEnv, type NetworkConfig } from '@/lib/config/network';
import { requestDb } from '@/lib/db/requestDb.js';

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
export function runtimeEnv(_locals?: App.Locals): Cloudflare.Env {
  if (!workersEnv) return {} as Cloudflare.Env;
  requestEnv ??= new Proxy(workersEnv as Cloudflare.Env, {
    // DB is the request's handle (a replica session for anonymous reads, see
    // lib/db/requestDb). Every other key goes to the live bindings object, so
    // no binding can get lost the way it could in a copy.
    get: (target, key) => (key === 'DB' ? requestDb() : Reflect.get(target, key)),
  });
  return requestEnv;
}
let requestEnv: Cloudflare.Env | undefined;

/**
 * Resolves the active Cardano network from the runtime env (CARDANO_NETWORK),
 * defaulting to mainnet when unset, with the KOIOS_BASE_URL test override
 * applied. Use from SSR pages, API routes and the Layout to keep the network in
 * one place. Reads the cloudflare:workers env, so call only from
 * server-rendered or build (prerender) contexts, not from node unit tests.
 */
export function currentNetwork(): NetworkConfig {
  return networkFromEnv(workersEnv ?? {});
}
