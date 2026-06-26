// POST /api/drep/multisig/[id]/witness
// Validates an incoming vkey witness and appends it to the pending multisig
// vote. The caller must be an authenticated DRep whose drep_id matches the row.
// Enforces single-witness-per-call to prevent a member from smuggling multiple
// or zero signatures in one request.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getUserById } from '@/lib/db/users';
import { getPendingMultisig, addPendingWitness } from '@/lib/db/pendingMultisigTx';
import { parseNativeScriptJson, collectSigKeyHashes, satisfactionProgress } from '@/lib/cardano/nativeScript';
import { validateWitness, parseWitnessSetHex } from '@/lib/governance/multisigWitness';

export const prerender = false;

const schema = z.object({
  witnessSetHex: z.string().regex(/^[0-9a-fA-F]+$/).min(2),
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

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return jsonResponse({ error: 'invalid input' }, 400);
  const body = parsed.data;

  const row = await getPendingMultisig(db, id);
  if (!row) return jsonResponse({ error: 'not found' }, 404);
  if (row.status !== 'collecting') return jsonResponse({ error: 'no longer collecting' }, 409);

  // Member gate: the session user's drep_id must match the row's drep_id.
  const dbUser = await getUserById(db, user.id);
  if (!dbUser?.drep_id || dbUser.drep_id !== row.drep_id) {
    return jsonResponse({ error: 'not a member' }, 403);
  }

  // Parse the stored native script so we can compute the authorized signer set.
  let script: ReturnType<typeof parseNativeScriptJson>;
  try {
    script = parseNativeScriptJson(JSON.parse(row.native_script));
  } catch {
    return jsonResponse({ error: 'corrupt record' }, 500);
  }
  if (!script) return jsonResponse({ error: 'corrupt record' }, 500);

  const sigLeaves = collectSigKeyHashes(script);

  const existing = JSON.parse(row.witnesses) as Array<{ key_hash: string; witness_hex: string }>;
  const already = new Set(existing.map((w) => w.key_hash));

  // Single-witness enforcement: exactly one vkey witness per call.
  let parsedWitnesses: ReturnType<typeof parseWitnessSetHex>;
  try {
    parsedWitnesses = parseWitnessSetHex(body.witnessSetHex);
  } catch {
    return jsonResponse({ error: 'expected exactly one signature' }, 400);
  }
  if (parsedWitnesses.length !== 1) {
    return jsonResponse({ error: 'expected exactly one signature' }, 400);
  }

  const result = validateWitness({
    witnessSetHex: body.witnessSetHex,
    bodyHashHex: row.body_hash,
    sigLeaves,
    already,
  });

  if (!result.ok) {
    switch (result.reason) {
      case 'no vkey':
        return jsonResponse({ error: 'That signature could not be read.' }, 400);
      case 'bad signature':
        return jsonResponse({ error: 'That signature does not match this transaction.' }, 422);
      case 'not a member':
        return jsonResponse({ error: "That key is not one of this DRep's authorized signers." }, 422);
      case 'duplicate':
        return jsonResponse({ error: 'This signer has already added a witness.' }, 409);
    }
  }

  await addPendingWitness(
    db,
    id,
    { key_hash: result.witness.keyHashHex, witness_hex: body.witnessSetHex },
    Math.floor(Date.now() / 1000),
  );

  // Re-read the updated row to build accurate progress.
  const updated = await getPendingMultisig(db, id);
  const updatedWitnesses = updated
    ? (JSON.parse(updated.witnesses) as Array<{ key_hash: string; witness_hex: string }>)
    : [...existing, { key_hash: result.witness.keyHashHex, witness_hex: body.witnessSetHex }];
  const signers = new Set(updatedWitnesses.map((w) => w.key_hash));
  const progress = satisfactionProgress(script, signers);

  return jsonResponse(
    {
      ok: true,
      satisfied: progress.satisfied,
      signedLeaves: progress.signedLeaves,
      threshold: progress.threshold,
    },
    200,
  );
};
