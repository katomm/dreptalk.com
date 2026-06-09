// GET /api/avatar/:drepId
//
// Same-origin avatar proxy for DRep CIP-119 profile images.
//
// WHY: DRep image URLs are stored on-chain (untrusted, third-party) and we must
// not hot-link them directly. Hot-linking leaks every visitor's IP to the
// upstream host and violates the same-origin CSP. This proxy fetches the image
// server-side, validates it, and re-serves it with an immutable cache header.
//
// Security hardening (the image URL is untrusted on-chain input):
//   1. https-only: any other scheme is rejected before fetch (-> 404).
//   2. Timeout via AbortController: 8 s.
//   3. Content-type allowlist: only raster types (png/jpeg/webp/gif/avif); svg rejected.
//   4. Size cap: 256 KB via content-length header check + body read cap.
//   5. No client headers forwarded to the upstream (least privilege).
//   6. No upstream headers leaked back except content-type.
//   7. X-Content-Type-Options: nosniff + restrictive CSP on every response.
//   8. Any failure path -> 404, never 500.

import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getDrepById } from '@/lib/db/dreps';

export const prerender = false;

// Maximum accepted response body size (256 KB). Images larger than this are
// almost always either mislinked or hostile payloads.
const MAX_IMAGE_BYTES = 256 * 1024;

// Upstream fetch timeout in milliseconds.
const FETCH_TIMEOUT_MS = 8_000;

// Immutable cache: CDN caches for 7 days, browsers for 1 day.
// The proxy URL is content-addressable by drepId, so long TTLs are safe.
const CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800, immutable';

// Raster types only. SVG is rejected: it can carry <script> and would execute
// in our origin on direct navigation to /api/avatar/:id.
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

// Injectable fetch: tests replace this before running.
export let _fetchImpl: typeof fetch = globalThis.fetch;

/** Replace the fetch implementation (for testing). */
export function _setFetchImpl(f: typeof fetch): void {
  _fetchImpl = f;
}

/** Returns true only for https:// URLs. Rejects http, data, javascript, etc. */
function isHttpsUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:';
  } catch {
    return false;
  }
}

const NOT_FOUND = new Response('not found', { status: 404 });

export const GET: APIRoute = async ({ params, locals }) => {
  const drepId = params.drepId as string | undefined;
  if (!drepId) return NOT_FOUND;

  // Resolve D1 binding from the Cloudflare runtime environment.
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return NOT_FOUND;

  // Look up the drep row. Missing row or missing image_url -> fall back to
  // initials avatar in the UI; do not error.
  let imageUrl: string | null = null;
  try {
    const drep = await getDrepById(db, drepId);
    imageUrl = drep?.imageUrl ?? null;
  } catch {
    return NOT_FOUND;
  }

  if (!imageUrl) return NOT_FOUND;

  // Scheme guard: only https:// is allowed. Reject http, data, javascript,
  // ipfs, and any other scheme without making a network request.
  if (!isHttpsUrl(imageUrl)) return NOT_FOUND;

  // Fetch with timeout and no forwarded client headers (least privilege).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await _fetchImpl(imageUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      // Explicitly empty headers: never send cookies or auth to the image host.
      headers: {},
    });
  } catch {
    // Network error or timeout (AbortError from the controller).
    return NOT_FOUND;
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) return NOT_FOUND;

  // Content-type guard: must be an allowlisted raster image. Rejects svg, json, html.
  const contentType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(contentType)) return NOT_FOUND;

  // Early-reject if content-length declares an oversize body.
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return NOT_FOUND;

  // Read the body and enforce the hard size cap.
  let buffer: ArrayBuffer;
  try {
    buffer = await upstream.arrayBuffer();
  } catch {
    return NOT_FOUND;
  }

  if (buffer.byteLength > MAX_IMAGE_BYTES) return NOT_FOUND;

  // Success: return the image bytes. Expose only content-type; do not leak
  // any other upstream headers (server, set-cookie, x-*, etc.).
  return new Response(buffer, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
};
