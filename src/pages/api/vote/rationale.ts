// POST /api/vote/rationale
// Hosts a vote rationale (CIP-100) and returns the content-addressed url + hash
// the client embeds as the on-chain vote anchor. Unauthenticated like the DRep
// metadata host; content-addressed writes cannot clobber; per-IP rate limited.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { handleVoteRationale } from '@/lib/governance/voteRationaleHandler';
import { RATIONALE_RATE_MAX, RATIONALE_RATE_WINDOW_SEC } from '@/lib/governance/voteLimits';

export const prerender = false;
// Shared constants: the batch UI caps distinct rationale texts at this same
// limit so a multi-vote submission can never 429 mid-hosting.
const RATE_MAX = RATIONALE_RATE_MAX;
const RATE_WINDOW_SEC = RATIONALE_RATE_WINDOW_SEC;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const rateLimiter = env.RATE_LIMITER;
  if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503);

  const clientIp = clientIpFrom(request.headers);
  const allowed = await checkRate(rateLimiter, `vote-rationale:${clientIp}`, {
    max: RATE_MAX,
    windowSec: RATE_WINDOW_SEC,
    now: Date.now(),
  });
  if (!allowed) return jsonResponse({ error: 'rate_limited' }, 429);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const result = await handleVoteRationale({
    body,
    db,
    origin: new URL(request.url).origin,
    now: Date.now(),
  });
  return jsonResponse(result.json, result.status);
};
