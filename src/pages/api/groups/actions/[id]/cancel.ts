// POST /api/groups/actions/[id]/cancel
// Cancels a group signing link, for its initiator only. The control slot stays held, since
// handed out witnesses stay usable until expiry. The fee inputs come back for the real
// cancellation, a send to self that spends them.
import type { APIRoute } from 'astro';
import { jsonResponse } from '@/lib/api/response';
import { cancelGroupAction } from '@/lib/groups/actionStore';
import { openRowRequest } from '@/lib/groups/actionServer';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
  const req = await openRowRequest(locals as App.Locals, params.id);
  if (req instanceof Response) return req;
  const { db, user, ctx } = req;
  if (ctx.row.created_by !== user.id) return jsonResponse({ error: 'only the initiator can cancel' }, 403);
  if (!(await cancelGroupAction(db, ctx.row.id, Math.floor(Date.now() / 1000)))) {
    return jsonResponse({ error: 'no longer collecting' }, 409);
  }
  return jsonResponse({ ok: true, feeInputs: ctx.feeInputs }, 200);
};
