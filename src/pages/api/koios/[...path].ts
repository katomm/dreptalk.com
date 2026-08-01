import type { APIRoute } from 'astro';
import { resolveNetwork } from '@/lib/config/network';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { readBodyLimited } from '@/lib/http/bodyLimit';
import type { RateLimiter } from '@/lib/rateLimiterDO';

export const prerender = false;

// Per-IP throttle: this proxy is unauthenticated and forwards to a metered
// upstream (Koios) using our server-side API key. Without a cap, anyone can
// exhaust the key's quota or use us as an open Koios proxy. The limit is
// generous so a legitimate tx build (several reads in a burst) is never blocked.
const RATE_MAX = 100;
const RATE_WINDOW_SEC = 60;

// Largest accepted request body. Legitimate Koios POST bodies are id arrays
// far below this; the cap keeps a hostile client from ballooning Worker memory.
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

// Hop-by-hop headers that must not be forwarded to the upstream.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

// GET endpoints the EvolutionSDK provider reads while building DRep txs:
// epoch_params (protocol parameters) and asset_addresses (resolve a unit).
// These are the only Koios GETs that flow through this proxy; every server-side
// read uses createKoiosClient against Koios directly, not this route. Explicit
// allowlist: deny everything not on it, mirroring the POST policy below.
const ALLOWED_GET_PATHS = new Set(['epoch_params', 'asset_addresses']);

// POST endpoints the EvolutionSDK provider calls for bulk reads.
// Explicit allowlist: deny everything not on it.
const ALLOWED_POST_PATHS = new Set([
  'drep_info',
  'account_info',
  'account_assets',
  'account_utxos',
  'address_info',
  'address_utxos',
  'address_assets',
  'pool_info',
  'pool_metadata',
  'utxo_info',
]);

// /submittx must never be forwarded: the wallet signs and submits directly.
const BLOCKED_POST_PATHS = new Set(['submittx']);

// Injectable fetch: default is global fetch; tests replace this before running.
export let _fetchImpl: typeof fetch = globalThis.fetch;

/** Replace the fetch implementation for testing. */
export function _setFetchImpl(f: typeof fetch): void {
  _fetchImpl = f;
}

// In the Workers runtime env is available via cloudflare:workers; in Node test
// environments it is not, so fall back to process.env. Dynamic require so Node
// tests never blow up on the missing virtual module.
function resolveWorkerEnv(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { env } = require('cloudflare:workers') as { env: Record<string, unknown> };
    return env;
  } catch {
    return process.env as unknown as Record<string, unknown>;
  }
}

function resolveKoiosConfig(): { baseUrl: string; token?: string } {
  const env = resolveWorkerEnv();
  const baseUrl = resolveNetwork((env.CARDANO_NETWORK as string | undefined) ?? null).koiosBaseUrl;
  const token = (env.KOIOS_API_KEY as string | undefined) || undefined;
  return { baseUrl, token };
}

// Enforces the per-IP quota; returns a 429 response when exceeded, else null.
// When the RATE_LIMITER binding is absent (Node unit tests) throttling is skipped.
async function throttle(request: Request): Promise<Response | null> {
  const rateLimiter = resolveWorkerEnv().RATE_LIMITER as DurableObjectNamespace<RateLimiter> | undefined;
  if (!rateLimiter) return null;
  const allowed = await checkRate(rateLimiter, `koios:${clientIpFrom(request.headers)}`, {
    max: RATE_MAX,
    windowSec: RATE_WINDOW_SEC,
    now: Date.now(),
  });
  if (allowed) return null;
  return new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });
}

async function proxyRequest(request: Request, subPath: string): Promise<Response> {
  const { baseUrl, token } = resolveKoiosConfig();

  // Reconstruct the upstream URL: base + path + original query string.
  const incomingUrl = new URL(request.url);
  const qs = incomingUrl.search; // includes leading "?" or empty string
  const upstreamUrl = `${baseUrl}/${subPath}${qs}`;

  // Build the upstream headers from scratch (least privilege): never forward the
  // client's own request headers (cookies, authorization, etc.) to Koios. Send
  // only what the upstream needs, plus our server-side token when configured.
  const outHeaders = new Headers({ accept: 'application/json' });
  if (request.method === 'POST' || request.method === 'PUT') {
    outHeaders.set('content-type', 'application/json');
  }
  if (token) {
    outHeaders.set('authorization', `Bearer ${token}`);
  }

  let body: ArrayBuffer | undefined;
  if (request.method === 'POST' || request.method === 'PUT') {
    // Honest oversize senders are rejected from the header alone; the bounded
    // reader below stays the enforced cap for chunked or lying ones.
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: 'body_too_large' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      });
    }
    const read = await readBodyLimited(request.body, MAX_BODY_BYTES);
    if (!read.ok) {
      return new Response(JSON.stringify({ error: 'body_too_large' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      });
    }
    // The reader allocates an exact-size buffer, so .buffer carries no slack.
    body = read.bytes.buffer as ArrayBuffer;
  }

  const upstream = await _fetchImpl(upstreamUrl, {
    method: request.method,
    headers: outHeaders,
    body: body ?? null,
  });

  // Stream the upstream response back, stripping hop-by-hop headers.
  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export const GET: APIRoute = async ({ request, params }) => {
  const subPath = (params.path as string | undefined) ?? '';

  // Deny-by-default: only the explicit read endpoints above are permitted.
  if (!ALLOWED_GET_PATHS.has(subPath)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  const limited = await throttle(request);
  if (limited) return limited;

  try {
    return await proxyRequest(request, subPath);
  } catch {
    return new Response(JSON.stringify({ error: 'upstream request failed' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const subPath = (params.path as string | undefined) ?? '';

  // Blocked paths are never forwarded regardless of allowlist position.
  if (BLOCKED_POST_PATHS.has(subPath)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Deny-by-default: only explicit bulk-read endpoints are permitted.
  if (!ALLOWED_POST_PATHS.has(subPath)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  const limited = await throttle(request);
  if (limited) return limited;

  try {
    return await proxyRequest(request, subPath);
  } catch {
    return new Response(JSON.stringify({ error: 'upstream request failed' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
};
