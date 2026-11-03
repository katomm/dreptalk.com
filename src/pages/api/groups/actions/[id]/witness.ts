// POST /api/groups/actions/[id]/witness
// Adds the signatures of a wallet witness set to a group signing link. Each vkey witness is
// verified over the body hash on its own and kept when its key is a required signer or a key of
// a policy the action needs. The initiator's witness for the payment key of a fee input is kept
// as the funding witness. Every other key is reported as ignored.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api/response';
import { addPendingWitness, getPendingMultisig, type PendingWitness } from '@/lib/db/pendingMultisigTx';
import { checkFresh, collectedSatisfy, koiosFor, openRowRequest, rowRateRefusal } from '@/lib/groups/actionServer';
import { neededPolicyKeys } from '@/lib/groups/actions';
import { type ParsedWitness, parseWitnessSetHex, singleWitnessSetHex, verifyVkeyWitness } from '@/lib/governance/multisigWitness';

export const prerender = false;

const schema = z.object({ witnessSetHex: z.string().regex(/^[0-9a-fA-F]+$/).min(2).max(32_768) });

export const POST: APIRoute = async ({ request, params, locals }) => {
  const req = await openRowRequest(locals as App.Locals, params.id);
  if (req instanceof Response) return req;
  const { db, env, user, ctx } = req;
  const limited = await rowRateRefusal(env, user.id);
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return jsonResponse({ error: 'invalid input' }, 400);
  let witnesses: ParsedWitness[];
  try {
    witnesses = parseWitnessSetHex(parsed.data.witnessSetHex);
  } catch {
    return jsonResponse({ error: 'That signature could not be read.' }, 400);
  }
  if (witnesses.length === 0) return jsonResponse({ error: 'That signature could not be read.' }, 400);
  if (!witnesses.every((w) => verifyVkeyWitness(w, ctx.row.body_hash))) {
    return jsonResponse({ error: 'That signature does not match this transaction.' }, 422);
  }

  const now = Math.floor(Date.now() / 1000);
  let fresh: Awaited<ReturnType<typeof checkFresh>>;
  try {
    fresh = await checkFresh(db, koiosFor(env), ctx, now);
  } catch (err) {
    console.error('[drep-groups] staleness check failed', err);
    return jsonResponse({ error: 'service unavailable' }, 503);
  }
  if (!fresh.ok) return jsonResponse({ error: fresh.error }, fresh.status);

  const signerKeys = new Set([...ctx.requiredSigners, ...neededPolicyKeys(ctx.intent, ctx.state, ctx.memberScript)]);
  const initiator = ctx.row.created_by === user.id;
  const accepted: string[] = [];
  const ignored: string[] = [];
  for (const w of witnesses) {
    const role: PendingWitness['role'] | null = signerKeys.has(w.keyHashHex)
      ? 'signer'
      : initiator && fresh.payKeys.has(w.keyHashHex)
        ? 'funding'
        : null;
    if (role === null) {
      ignored.push(w.keyHashHex);
      continue;
    }
    const outcome = await addPendingWitness(db, ctx.row.id, { key_hash: w.keyHashHex, witness_hex: singleWitnessSetHex(w), role }, now);
    if (outcome === 'gone') return jsonResponse({ error: 'no longer collecting' }, 409);
    accepted.push(w.keyHashHex);
  }

  const updated = await getPendingMultisig(db, ctx.row.id);
  const satisfied = updated ? collectedSatisfy({ ...ctx, witnesses: JSON.parse(updated.witnesses) as PendingWitness[] }) : false;
  return jsonResponse({ accepted, ignored, satisfied }, 200);
};
