// POST /api/drep/multisig/[id]/submitted
// Records the result after the browser submits the assembled tx: marks the
// pending row as submitted and writes an optimistic local vote to drep_votes
// so the vote is visible immediately, before the hourly on-chain sync.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getUserById } from '@/lib/db/users';
import { getPendingMultisig, markPendingSubmitted } from '@/lib/db/pendingMultisigTx';
import { recordLocalVote } from '@/lib/db/drepVotes';

export const prerender = false;

const schema = z.object({
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user?.roles.includes('drep')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const { id } = params;
  if (!id) return jsonResponse({ error: 'invalid input' }, 400);

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503);

  const row = await getPendingMultisig(db, id);
  if (!row) return jsonResponse({ error: 'not found' }, 404);

  // Member gate: the session user's drep_id must match the row's drep_id.
  const dbUser = await getUserById(db, user.id);
  if (!dbUser?.drep_id || dbUser.drep_id !== row.drep_id) {
    return jsonResponse({ error: 'not a member' }, 403);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return jsonResponse({ error: 'invalid input' }, 400);
  const { txHash } = parsed.data;

  // Idempotency guard: only accept the first submitted report.
  if (row.status !== 'collecting') {
    return jsonResponse({ error: 'already submitted' }, 409);
  }

  let actionParams: { gaId: string; vote: string; anchorUrl?: string };
  try {
    actionParams = JSON.parse(row.action_params) as { gaId: string; vote: string; anchorUrl?: string };
  } catch {
    return jsonResponse({ error: 'corrupt record' }, 500);
  }

  const now = Math.floor(Date.now() / 1000);

  await markPendingSubmitted(db, id, txHash, now);
  await recordLocalVote(db, {
    gaId: actionParams.gaId,
    drepId: row.drep_id,
    voterHex: null,
    vote: actionParams.vote,
    metaUrl: actionParams.anchorUrl ?? null,
    txHash,
    now,
  });

  return jsonResponse({ ok: true }, 200);
};
