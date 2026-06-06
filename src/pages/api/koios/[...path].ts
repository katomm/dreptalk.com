import type { APIRoute } from 'astro';
import { resolveNetwork } from '@/lib/config/network';

export const prerender = false;

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

function resolveKoiosBaseUrl(): string {
  // In Workers runtime env is available via cloudflare:workers.
  // In Node test environments it is not, so fall back to process.env.
  let networkValue: string | undefined;
  try {
    // Dynamic require so Node tests never blow up on the missing virtual module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { env } = require('cloudflare:workers') as { env: Record<string, string | undefined> };
    networkValue = env.CARDANO_NETWORK;
  } catch {
    networkValue = process.env.CARDANO_NETWORK;
  }
  return resolveNetwork(networkValue ?? null).koiosBaseUrl;
}

function resolveKoiosToken(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { env } = require('cloudflare:workers') as { env: Record<string, string | undefined> };
    return env.KOIOS_API_KEY || undefined;
  } catch {
    return process.env.KOIOS_API_KEY || undefined;
  }
}

async function proxyRequest(request: Request, subPath: string): Promise<Response> {
  const baseUrl = resolveKoiosBaseUrl();
  const token = resolveKoiosToken();

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

  const body =
    request.method === 'POST' || request.method === 'PUT'
      ? await request.arrayBuffer()
      : undefined;

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
  try {
    const subPath = (params.path as string | undefined) ?? '';
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

  try {
    return await proxyRequest(request, subPath);
  } catch {
    return new Response(JSON.stringify({ error: 'upstream request failed' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
};
