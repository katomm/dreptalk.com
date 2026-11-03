// POST /api/groups/actions/[id]/submit
// Assembles a fully signed group transaction. Every required signer has signed, the funding
// witness is there, and the engine's rules over the current state find every event valid with the
// collected signers. Does not call the chain, the browser submits the returned transaction.
import type { APIRoute } from 'astro';
import { jsonResponse } from '@/lib/api/response';
import {
  assembleTx,
  checkFresh,
  decodeGroupTx,
  koiosFor,
  openRowRequest,
  payloadMembers,
  rowRateRefusal,
  submitBlocker,
  witnessKeys,
} from '@/lib/groups/actionServer';
import { liveFactsFor, PreviewUnavailable, previewGroupTx } from '@/lib/groups/preview';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
  const req = await openRowRequest(locals as App.Locals, params.id);
  if (req instanceof Response) return req;
  const { db, env, user, ctx } = req;
  const limited = await rowRateRefusal(env, user.id);
  if (limited) return limited;
  const koios = koiosFor(env);
  const now = Math.floor(Date.now() / 1000);

  try {
    const fresh = await checkFresh(db, koios, ctx, now);
    if (!fresh.ok) return jsonResponse({ error: fresh.error }, fresh.status);
    const blocker = submitBlocker(ctx, fresh.payKeys);
    if (blocker) return jsonResponse({ error: blocker }, 409);
    const signed = new Set(witnessKeys(ctx.witnesses));
    const live = await liveFactsFor(koios, payloadMembers(ctx.intent));
    const preview = await previewGroupTx(db, ctx.tx.bytes, ctx.tx.chain.requiredSigners, [...signed], live);
    if (!('events' in preview)) return jsonResponse({ error: `transaction would be ignored: ${preview.ignored}` }, 409);
    const invalid = preview.events.find((e) => !e.valid);
    if (invalid) return jsonResponse({ error: invalid.reason ?? 'event not valid' }, 409);

    const assembled = assembleTx(ctx.row.unsigned_tx_cbor, ctx.witnesses);
    if (decodeGroupTx(assembled).bodyHash !== ctx.row.body_hash) throw new Error('assembly changed the body');
    return jsonResponse({ assembledTxHex: assembled }, 200);
  } catch (err) {
    if (err instanceof PreviewUnavailable) return jsonResponse({ error: err.message }, 503);
    console.error('[drep-groups] assembling a group action failed', err);
    return jsonResponse({ error: 'service unavailable' }, 503);
  }
};
