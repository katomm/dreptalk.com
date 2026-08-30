// POST /api/drep/voting-power-origins: the voting-power composition analysis
// for the signed-in DRep. Thin route: gates + rate limit + 3h TTL cache +
// wiring the real Koios client into computeProvenance. The drep_id comes from
// the authenticated session's user row, never from the request. Privacy: no
// stake addresses reach D1, the response, or logs (do not add logging here).
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { isSameOriginRequest } from '@/lib/http/origin';
import { currentEpochProgress, resolveNetwork } from '@/lib/config/network';
import { createKoiosClient } from '@/lib/koios/client';
import { getUserById } from '@/lib/db/users';
import { getProvenanceCache, isFreshProvenanceCache, putProvenanceCache } from '@/lib/db/provenanceCache';
import { isCurrentPayloadVersion, type ProvenancePayload, type ProvenanceWindow } from '@/lib/delegation/provenance';
import { computeProvenance } from '@/lib/delegation/provenanceCompute';

export const prerender = false;

// Authenticated and cached, so the budget only needs to absorb a legitimate
// DRep switching windows and retrying, not open internet abuse.
const USER_RATE_MAX = 10;
const IP_RATE_MAX = 20;
const RATE_WINDOW_SEC = 600;

const schema = z.object({
  window: z.union([z.literal(12), z.literal(36), z.literal(73)]),
});

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = (locals as App.Locals).user;
    if (!user?.roles.includes('drep')) return jsonResponse({ error: 'unauthorized' }, 401);
    if (!isSameOriginRequest(request)) return jsonResponse({ error: 'forbidden' }, 403);

    const env = runtimeEnv(locals as App.Locals);
    const db = env.DB as D1Database | undefined;
    const rateLimiter = env.RATE_LIMITER;
    if (!db || !rateLimiter) return jsonResponse({ error: 'service unavailable' }, 503);

    // Rate check before input validation: cheap, and it keeps the whole
    // request budget behind one gate (the tests probe the limiter with an
    // invalid window so they never reach Koios).
    const clientIp = clientIpFrom(request.headers);
    const now = Date.now();
    const [userAllowed, ipAllowed] = await Promise.all([
      checkRate(rateLimiter, `vporig:u:${user.id}`, { max: USER_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
      checkRate(rateLimiter, `vporig:ip:${clientIp}`, { max: IP_RATE_MAX, windowSec: RATE_WINDOW_SEC, now }),
    ]);
    if (!userAllowed || !ipAllowed) return jsonResponse({ error: 'rate_limited' }, 429);

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid JSON' }, 400);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return jsonResponse({ error: 'invalid window' }, 400);
    const windowEpochs = parsed.data.window as ProvenanceWindow;

    const dbUser = await getUserById(db, user.id);
    const drepId = dbUser?.drep_id ?? null;
    if (!drepId) return jsonResponse({ error: 'unauthorized' }, 401);

    const cached = await getProvenanceCache(db, drepId, windowEpochs);
    if (cached && isFreshProvenanceCache(cached.computedAt, now) && isCurrentPayloadVersion(cached.payload)) {
      return new Response(cached.payload, { headers: { 'content-type': 'application/json' } });
    }

    const networkEnv = (env.CARDANO_NETWORK as string | undefined) ?? null;
    const cfg = resolveNetwork(networkEnv);
    const currentEpoch = currentEpochProgress(now, cfg).epoch;

    // Local dev stub: SSR fetches to Koios hang under astro dev (workerd
    // quirk), so .dev.vars can switch the route to a fixture payload. Gated
    // on DEV as well as the var so this fixture can never serve in production.
    if (import.meta.env.DEV && env.PROVENANCE_STUB === '1') {
      return jsonResponse(stubPayload(now, currentEpoch, windowEpochs));
    }

    const koios = createKoiosClient({
      baseUrl: cfg.koiosBaseUrl,
      token: env.KOIOS_API_KEY || undefined,
      timeoutMs: 15_000,
      retries: 2,
    });

    try {
      const payload = await computeProvenance({ koios, db, drepId, windowEpochs, currentEpoch, now });
      const json = JSON.stringify(payload);
      await putProvenanceCache(db, drepId, windowEpochs, json, now);
      return new Response(json, { headers: { 'content-type': 'application/json' } });
    } catch {
      // Anything thrown while computing (a Koios HTTP error, a timeout/abort,
      // zod shape drift on a Koios response) is treated as one upstream-class
      // failure: distinguishing them here is brittle, and none of them cache
      // anything, so the next attempt just recomputes.
      return jsonResponse({ error: 'upstream' }, 502);
    }
  } catch {
    return jsonResponse({ error: 'internal' }, 500);
  }
};

// Fixture for local visual work, mirroring the approved mockup's data: every
// source type, returning counts, a capped remainder, re-cert reclassifications
// and a few unresolved accounts.
function stubPayload(computedAt: number, currentEpoch: number, windowEpochs: number): ProvenancePayload {
  return {
    version: 1,
    computedAt,
    currentEpoch,
    windowEpochs,
    base: { count: 579, amount: '49700000000000' },
    sources: [
      {
        type: 'drep', drepId: 'drep1stubmidnight', name: 'Midnight Circle',
        hex: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c',
        slug: 'midnight-circle', count: 96, amount: '3100000000000', returningCount: 22,
      },
      { type: 'new', count: 171, amount: '2000000000000', returningCount: 0 },
      {
        type: 'drep', drepId: 'drep1stubnordwind', name: 'Nordwind Collective',
        hex: '2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d',
        slug: 'nordwind-collective', count: 61, amount: '1600000000000', returningCount: 8,
      },
      { type: 'abstain', count: 48, amount: '900000000000', returningCount: 6 },
      {
        type: 'drep', drepId: 'drep1stubquill', name: 'Quill Collective',
        hex: '3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e',
        slug: 'quill-collective', count: 33, amount: '500000000000', returningCount: 3,
      },
      { type: 'drep', drepId: 'drep1stubfar', name: null, hex: null, slug: null, count: 31, amount: '400000000000', returningCount: 2 },
      { type: 'unknown', count: 17, amount: '200000000000', returningCount: 0 },
    ],
    coverage: {
      analyzedCandidateCount: 500, totalCandidateCount: 743,
      analyzedCandidateAmount: '9100000000000', totalCandidateAmount: '10500000000000',
    },
    notAnalyzed: { count: 243, amount: '1400000000000' },
    unresolved: { count: 5, amount: '90000000000' },
    reclassifiedBaseCount: 38,
    returningTotal: 41,
  };
}
