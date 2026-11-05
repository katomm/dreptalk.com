// GET /api/groups/actions/[id]
// A group signing link with its events in plain words and the signatures collected so far. Only
// a session that may sign the action reads it, the link alone is not a capability for group rows.
import type { APIRoute } from 'astro';
import { jsonResponse } from '@/lib/api/response';
import { collectedSatisfy, feeInputKeys, koiosFor, linesOf, openRowRequest, submitBlocker, witnessKeys } from '@/lib/groups/actionServer';
import { groupIdString } from '@/lib/groups/ids';
import { drepNamesForKeyHashes } from '@/lib/db/drepGroups';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const req = await openRowRequest(locals as App.Locals, params.id);
  if (req instanceof Response) return req;
  const { db, env, ctx, session } = req;
  const { row, intent } = ctx;
  const initiator = row.created_by === req.user.id;
  const required = new Set(ctx.requiredSigners);
  const signers = witnessKeys(ctx.witnesses, 'signer');
  const satisfied = collectedSatisfy(ctx);
  // The same rule as submit with the payment keys stored on the row. Koios is asked only once the
  // signatures are complete, for whether a fee input was spent. Koios failing hides the button.
  // The resolver records a fee input another transaction spent, so the polls need no Koios call
  // to tell. The check before submitting can find it first.
  let feeInputSpent = row.spent_seen_h !== null;
  let canSubmit = false;
  if (row.status === 'collecting' && !feeInputSpent && submitBlocker(ctx, ctx.feePayKeys) === null) {
    try {
      feeInputSpent = (await feeInputKeys(koiosFor(env), ctx.feeInputs)).spent;
      canSubmit = !feeInputSpent;
    } catch (err) {
      console.warn(`[drep-groups] fee inputs of ${row.id} could not be read`, err);
    }
  }
  const lines = await linesOf(db, ctx);
  // DRep names of the signers and the viewer, so the page names who signs.
  const names = await drepNamesForKeyHashes(db, [...new Set([...ctx.requiredSigners, ...signers, ...(session.keyHash ? [session.keyHash] : [])])]);
  return jsonResponse(
    {
      id: row.id,
      kind: row.action,
      status: row.status,
      resolution: row.resolution,
      groupId: ctx.state ? groupIdString(ctx.state.ref) : intent.kind === 'group_create' ? row.drep_id : intent.group,
      lines,
      requiredSigners: ctx.requiredSigners,
      signed: signers.filter((k) => required.has(k)),
      optionalSigned: signers.filter((k) => !required.has(k)),
      satisfied,
      expiresAt: row.expires_at,
      invalidHereafter: row.invalid_hereafter,
      unsignedTxCbor: row.unsigned_tx_cbor,
      bodyHash: row.body_hash,
      canSubmit,
      feeInputSpent,
      isInitiator: initiator,
      // The viewer's DRep key and whether its signature is still wanted: the wallet signs only for
      // the required signers the transaction was built with.
      viewerKey: session.keyHash,
      names: Object.fromEntries(names),
      fundingSigned: witnessKeys(ctx.witnesses, 'funding').length > 0,
      // Only the initiator needs the fee inputs, for the real cancellation that spends them back.
      feeInputs: initiator ? ctx.feeInputs : [],
      slotHeld: row.control_slot === 1 && row.resolved_at === null,
    },
    200,
  );
};
