// GET /api/groups/actions/[id]
// A group signing link with its events in plain words and the signatures collected so far. Only
// a session that may sign the action reads it, the link alone is not a capability for group rows.
import type { APIRoute } from 'astro';
import { jsonResponse } from '@/lib/api/response';
import { collectedSatisfy, feeInputKeys, koiosFor, linesOf, openRowRequest, submitBlocker, witnessKeys } from '@/lib/groups/actionServer';
import { groupIdString } from '@/lib/groups/ids';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const req = await openRowRequest(locals as App.Locals, params.id);
  if (req instanceof Response) return req;
  const { db, env, ctx } = req;
  const { row, intent } = ctx;
  const required = new Set(ctx.requiredSigners);
  const signers = witnessKeys(ctx.witnesses, 'signer');
  const satisfied = collectedSatisfy(ctx);
  // The same rule as submit, without its Koios backed freshness checks. Koios failing hides the button.
  let canSubmit = false;
  if (row.status === 'collecting') {
    try {
      const fee = await feeInputKeys(koiosFor(env), ctx.feeInputs);
      canSubmit = !fee.spent && submitBlocker(ctx, fee.payKeys) === null;
    } catch (err) {
      console.warn(`[drep-groups] fee inputs of ${row.id} could not be read`, err);
    }
  }
  return jsonResponse(
    {
      id: row.id,
      kind: row.action,
      status: row.status,
      resolution: row.resolution,
      groupId: ctx.state ? groupIdString(ctx.state.ref) : intent.kind === 'group_create' ? row.drep_id : intent.group,
      lines: await linesOf(db, ctx),
      requiredSigners: ctx.requiredSigners,
      signed: signers.filter((k) => required.has(k)),
      optionalSigned: signers.filter((k) => !required.has(k)),
      satisfied,
      expiresAt: row.expires_at,
      invalidHereafter: row.invalid_hereafter,
      unsignedTxCbor: row.unsigned_tx_cbor,
      bodyHash: row.body_hash,
      canSubmit,
      slotHeld: row.control_slot === 1 && row.resolved_at === null,
    },
    200,
  );
};
