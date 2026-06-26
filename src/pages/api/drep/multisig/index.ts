// POST /api/drep/multisig
// Validates and stores a client-built unsigned vote tx for a native-script
// (multisig) DRep. The tx is built client-side (only the browser has the
// funder wallet's UTxOs); this endpoint does membership gating, native-script
// validation, and storage only.
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { getUserById } from '@/lib/db/users';
import { parseDrepId } from '@/lib/cardano/identity';
import { parseNativeScriptJson, nativeScriptHash } from '@/lib/cardano/nativeScript';
import { createKoiosClient } from '@/lib/koios/client';
import { resolveNetwork } from '@/lib/config/network';
import { createPendingMultisig } from '@/lib/db/pendingMultisigTx';

export const prerender = false;

const schema = z.object({
  scriptDrepId: z.string(),
  gaId: z.string().regex(/^[0-9a-fA-F]{64}#\d{1,5}$/),
  vote: z.enum(['yes', 'no', 'abstain']),
  unsignedTxCbor: z.string().regex(/^[0-9a-fA-F]+$/),
  bodyHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  anchorUrl: z.string().url().optional(),
  anchorHashHex: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as App.Locals).user;
  if (!user?.roles.includes('drep')) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

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

  // Membership check: the session user's drep_id must equal the submitted script drep id.
  // Never trust the client's claim; derive it from the authenticated session.
  const dbUser = await getUserById(db, user.id);
  const drepId = dbUser?.drep_id ?? null;
  if (!drepId || drepId !== body.scriptDrepId) {
    return jsonResponse({ error: 'not a member' }, 403);
  }

  // Verify the DRep id is a script credential (not a key credential).
  const parsedDrep = parseDrepId(body.scriptDrepId);
  if (parsedDrep?.kind !== 'script') {
    return jsonResponse({ error: 'not a script drep' }, 422);
  }

  // Fetch the script from Koios and confirm it is a native (timelock) script.
  const networkEnv = (env.CARDANO_NETWORK as string | undefined) ?? null;
  const { koiosBaseUrl } = resolveNetwork(networkEnv);
  const koiosToken = (env.KOIOS_API_KEY as string | undefined) || undefined;
  const koios = createKoiosClient({ baseUrl: koiosBaseUrl, token: koiosToken });

  const info = await koios.scriptInfo(parsedDrep.hashHex);
  if (!info) {
    return jsonResponse({ error: 'script not found' }, 422);
  }
  if (info.type !== 'timelock') {
    return jsonResponse(
      { error: 'Plutus-script DReps cannot vote. Only native-script DReps are supported.' },
      422,
    );
  }

  // Parse the native-script JSON and recompute the hash for defense in depth.
  const script = parseNativeScriptJson(info.value);
  if (!script) {
    return jsonResponse({ error: 'unsupported script' }, 422);
  }
  if (nativeScriptHash(script) !== parsedDrep.hashHex) {
    return jsonResponse({ error: 'script hash mismatch' }, 422);
  }

  // Generate a stable token id and store the pending tx.
  const id = crypto.randomUUID().replace(/-/g, '');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 36 * 3600;

  await createPendingMultisig(db, {
    id,
    drepId: body.scriptDrepId,
    action: 'vote',
    actionParams: JSON.stringify({
      gaId: body.gaId,
      vote: body.vote,
      anchorUrl: body.anchorUrl,
      anchorHashHex: body.anchorHashHex,
    }),
    unsignedTxCbor: body.unsignedTxCbor,
    bodyHash: body.bodyHash,
    nativeScript: JSON.stringify(script),
    createdBy: user.id,
    createdAt: now,
    expiresAt,
  });

  return jsonResponse({ id }, 200);
};
