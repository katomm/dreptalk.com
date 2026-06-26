// GET /api/drep/multisig/[id]
// Returns a decoded pending native-script vote with its signature satisfaction
// progress. No auth is required: the link token itself is the read capability.
import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getPendingMultisig } from '@/lib/db/pendingMultisigTx';
import { parseNativeScriptJson, satisfactionProgress } from '@/lib/cardano/nativeScript';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const { id } = params;
  if (!id) return jsonResponse({ error: 'missing id' }, 400);

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503);

  const row = await getPendingMultisig(db, id);
  if (!row) return jsonResponse({ error: 'not found' }, 404);

  let script: ReturnType<typeof parseNativeScriptJson>;
  let witnesses: Array<{ key_hash: string; witness_hex: string }>;
  let actionParams: {
    gaId: string;
    vote: string;
    anchorUrl?: string;
    anchorHashHex?: string;
  };

  try {
    script = parseNativeScriptJson(JSON.parse(row.native_script));
    if (!script) return jsonResponse({ error: 'corrupt script' }, 500);

    const parsedWitnesses = JSON.parse(row.witnesses) as Array<{ key_hash: string; witness_hex: string }> | null;
    witnesses = (parsedWitnesses ?? []) as Array<{ key_hash: string; witness_hex: string }>;

    actionParams = JSON.parse(row.action_params) as {
      gaId: string;
      vote: string;
      anchorUrl?: string;
      anchorHashHex?: string;
    };
  } catch {
    return jsonResponse({ error: 'corrupt record' }, 500);
  }

  const signers = new Set(witnesses.map((w) => w.key_hash));
  const progress = satisfactionProgress(script, signers);

  return jsonResponse(
    {
      id: row.id,
      drepId: row.drep_id,
      action: row.action,
      gaId: actionParams.gaId,
      vote: actionParams.vote,
      anchorUrl: actionParams.anchorUrl ?? null,
      status: row.status,
      txHash: row.tx_hash,
      satisfied: progress.satisfied,
      signedLeaves: progress.signedLeaves,
      totalLeaves: progress.totalLeaves,
      threshold: progress.threshold,
      signers: [...signers],
      unsignedTxCbor: row.unsigned_tx_cbor,
      bodyHash: row.body_hash,
      expiresAt: row.expires_at,
    },
    200,
  );
};
