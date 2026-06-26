// POST /api/drep/multisig/[id]/submit
// Re-checks satisfaction, folds the collected member witness sets into the
// unsigned tx, and returns { assembledTxHex }. Does NOT call the chain.
// The browser then calls walletApi.signTx(assembledTxHex, true) to add the
// funding-input witness, folds it in, and calls submitTx. The resulting tx
// hash is reported back via POST /api/drep/multisig/[id]/submitted.
import type { APIRoute } from 'astro';
import { Transaction } from '@evolution-sdk/evolution';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getUserById } from '@/lib/db/users';
import { getPendingMultisig } from '@/lib/db/pendingMultisigTx';
import { parseNativeScriptJson, isNativeScriptSatisfied } from '@/lib/cardano/nativeScript';

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
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

  const now = Math.floor(Date.now() / 1000);
  if (now > row.expires_at) return jsonResponse({ error: 'expired' }, 410);

  if (row.status !== 'collecting') return jsonResponse({ error: 'no longer collecting' }, 409);

  // Parse the stored native script; a corrupt record is a server fault.
  let script: ReturnType<typeof parseNativeScriptJson>;
  try {
    script = parseNativeScriptJson(JSON.parse(row.native_script));
  } catch {
    return jsonResponse({ error: 'corrupt record' }, 500);
  }
  if (!script) return jsonResponse({ error: 'corrupt record' }, 500);

  const existing = JSON.parse(row.witnesses) as Array<{ key_hash: string; witness_hex: string }>;
  const signers = new Set(existing.map((w) => w.key_hash));

  if (!isNativeScriptSatisfied(script, signers)) {
    return jsonResponse({ error: 'not yet satisfied' }, 409);
  }

  // Fold each collected witness set into the unsigned tx one by one.
  let assembledHex = row.unsigned_tx_cbor;
  for (const w of existing) {
    assembledHex = Transaction.addVKeyWitnessesHex(assembledHex, w.witness_hex);
  }

  return jsonResponse({ assembledTxHex: assembledHex }, 200);
};
