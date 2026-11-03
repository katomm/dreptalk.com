// POST /api/groups/actions/[id]/submitted
// Records that the browser submitted the group transaction. The tx hash must be the body hash, the
// collected witnesses must be complete, and of two concurrent reports exactly one claims the row.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api/response';
import { markPendingSubmitted } from '@/lib/db/pendingMultisigTx';
import { openRowRequest, submitBlocker } from '@/lib/groups/actionServer';

export const prerender = false;

const schema = z.object({ txHash: z.string().regex(/^[0-9a-fA-F]{64}$/) });

export const POST: APIRoute = async ({ request, params, locals }) => {
  const req = await openRowRequest(locals as App.Locals, params.id);
  if (req instanceof Response) return req;
  const { db, ctx } = req;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return jsonResponse({ error: 'invalid input' }, 400);
  const txHash = parsed.data.txHash.toLowerCase();
  if (txHash !== ctx.row.body_hash) return jsonResponse({ error: 'transaction hash does not match this action' }, 422);
  if (ctx.row.status === 'cancelled') return jsonResponse({ error: 'action was cancelled' }, 409);
  // The same rule as submit, on the stored fee payment keys: an incomplete row cannot have been submitted.
  const blocker = submitBlocker(ctx, ctx.feePayKeys);
  if (blocker) return jsonResponse({ error: blocker }, 409);
  if (!(await markPendingSubmitted(db, ctx.row.id, txHash, Math.floor(Date.now() / 1000)))) {
    return jsonResponse({ error: 'already submitted' }, 409);
  }
  return jsonResponse({ ok: true }, 200);
};
