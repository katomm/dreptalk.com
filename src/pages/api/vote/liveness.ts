// POST /api/vote/liveness
// Pre-signing re-check for the multi-vote batch: returns which of the given
// governance actions are still active. A multi-vote transaction is
// all-or-nothing on-chain (one ratified/expired action invalidates every vote
// in it), so the client drops stale actions BEFORE the wallet signs. Gated to
// DReps like /api/vote/record; the data is public but the endpoint exists
// only for the vote flow.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';

export const prerender = false;

// Cap well below D1's 100-bound-params-per-query limit.
const schema = z.object({
  gaIds: z.array(z.string().regex(/^[0-9a-fA-F]{64}#\d{1,5}$/)).min(1).max(50),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user?.roles.includes('drep')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return jsonResponse({ error: 'invalid input' }, 400);
  const gaIds = parsed.data.gaIds;

  const placeholders = gaIds.map(() => '?').join(',');
  const rows =
    (
      await db
        .prepare(`SELECT id FROM governance_actions WHERE status = 'active' AND id IN (${placeholders})`)
        .bind(...gaIds)
        .all<{ id: string }>()
    ).results ?? [];

  return jsonResponse({ active: rows.map((r) => r.id) });
};
