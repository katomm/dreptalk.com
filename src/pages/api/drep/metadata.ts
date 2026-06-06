// POST /api/drep/metadata
//
// Accepts a DRep's profile fields, builds the CIP-119 metadata document,
// stores it in D1, and returns the stable URL + blake2b-256 hash that the
// client embeds as the on-chain anchor.
//
// Security: zod validation, IP-based rate limiting, parameterized D1 writes.
// The server never receives or handles private keys.

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { buildDrepMetadata } from '@/lib/governance/drepMetadata';
import { putDrepMetadata } from '@/lib/db/drepMetadata';

export const prerender = false;

// CIP-129 DRep id: bech32 with "drep1" prefix, 10 to 120 alphanumeric chars.
const DREP_ID_RE = /^drep1[0-9a-z]{10,120}$/;

// Zod schema for the request body. Links array is capped at 20 here; the
// buildDrepMetadata builder applies the tighter CIP-119 cap of 6 afterwards.
const bodySchema = z.object({
  drepId: z.string().regex(DREP_ID_RE, 'invalid drep id'),
  name: z.string(),
  bio: z.string(),
  links: z.array(z.string()).max(20),
});

// Rate-limit config: 10 submissions per 60 s per client IP.
// Tighter than the forum write limits because metadata submissions are
// infrequent by nature and each one writes to D1.
const RATE_MAX = 10;
const RATE_WINDOW_SEC = 60;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateKv = env.NONCES as KVNamespace | undefined;

  if (!db || !rateKv) {
    return jsonResponse({ error: 'service unavailable' }, 503);
  }

  // Parse JSON body.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  // Validate shape with zod.
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.issues[0]?.message ?? 'invalid input' }, 400);
  }

  const { drepId, name, bio, links } = parsed.data;

  // Rate-limit by client IP. Fall back to "unknown" if the header is absent
  // (e.g. in tests without cf-connecting-ip), which still provides a shared
  // counter that prevents unbounded writes in misconfigured environments.
  const clientIp =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';

  const allowed = await checkRate(rateKv, `drep-meta:${clientIp}`, {
    max: RATE_MAX,
    windowSec: RATE_WINDOW_SEC,
    now: Date.now(),
  });
  if (!allowed) {
    return jsonResponse({ error: 'rate_limited' }, 429);
  }

  // Build the CIP-119 document and compute its hash.
  const m = buildDrepMetadata({ name, bio, links });

  // Derive the absolute metadata URL from the request origin.
  const origin = new URL(request.url).origin;
  const url = `${origin}/drep/${drepId}/metadata.json`;

  // Persist to D1. Uses INSERT OR REPLACE so re-submissions update atomically.
  await putDrepMetadata(db, {
    drepId,
    body: m.body,
    hash: m.hash,
    name: m.name,
    createdAt: Math.floor(Date.now() / 1000),
  });

  return jsonResponse({ url, hash: m.hash }, 200);
};
