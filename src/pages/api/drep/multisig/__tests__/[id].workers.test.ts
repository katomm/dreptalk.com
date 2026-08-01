/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for GET /api/drep/multisig/[id].
// Calls the exported GET handler directly with a synthetic APIContext so
// the test runs inside the real Workers runtime (D1 via cloudflare:test)
// without needing an HTTP server or the Astro middleware chain.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { parseNativeScriptJson, nativeScriptHash } from '@/lib/cardano/nativeScript';
import { createPendingMultisig } from '@/lib/db/pendingMultisigTx';
import { GET } from '../[id]';

// ---------------------------------------------------------------------------
// Script fixture: a known 2-of-3 atLeast native script.
// ---------------------------------------------------------------------------

const KEY_A = 'a'.repeat(56);
const KEY_B = 'b'.repeat(56);
const KEY_C = 'c'.repeat(56);

const SCRIPT_VALUE = {
  type: 'atLeast',
  required: 2,
  scripts: [
    { type: 'sig', keyHash: KEY_A },
    { type: 'sig', keyHash: KEY_B },
    { type: 'sig', keyHash: KEY_C },
  ],
};
const PARSED_SCRIPT = parseNativeScriptJson(SCRIPT_VALUE)!;
const SCRIPT_HASH = nativeScriptHash(PARSED_SCRIPT);

const GA_ID = `${'d'.repeat(64)}#0`;
const VOTE = 'yes';
const TX_CBOR = 'e'.repeat(128);
const BODY_HASH = 'f'.repeat(64);
const DREP_ID = `drep-script-${SCRIPT_HASH.slice(0, 8)}`;
const ROW_ID = 'test-row-id-001';
const NOW = 1_752_000_000;

// One witness already added: KEY_A signed, but 2 of 3 required so not satisfied yet.
const WITNESSES = [{ key_hash: KEY_A, witness_hex: '00'.repeat(64) }];

// Seed a pending multisig row with one existing witness.
async function seedRow(id = ROW_ID) {
  await createPendingMultisig(env.DB, {
    id,
    drepId: DREP_ID,
    action: 'vote',
    actionParams: JSON.stringify({ gaId: GA_ID, vote: VOTE }),
    unsignedTxCbor: TX_CBOR,
    bodyHash: BODY_HASH,
    nativeScript: JSON.stringify(SCRIPT_VALUE),
    createdBy: 'user-abc',
    createdAt: NOW,
    expiresAt: NOW + 86400,
  });
  // Inject witness directly since addPendingWitness reads the whole row.
  await env.DB.prepare(`UPDATE pending_multisig_tx SET witnesses = ? WHERE id = ?`)
    .bind(JSON.stringify(WITNESSES), id)
    .run();
}

// Build a synthetic APIContext for GET /api/drep/multisig/[id].
function makeCtx(id: string | undefined) {
  const request = new Request(`https://dreptalk.com/api/drep/multisig/${id ?? ''}`, {
    method: 'GET',
  });
  const locals = {} as unknown as App.Locals;
  const params = id !== undefined ? { id } : {};
  return { request, locals, params } as Parameters<typeof GET>[0];
}

describe('GET /api/drep/multisig/[id]', () => {
  it('returns 404 for a missing id', async () => {
    const res = await GET(makeCtx('nonexistent-id-xyz'));
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('not found');
  });

  it('returns 400 when id param is absent', async () => {
    const res = await GET(makeCtx(undefined));
    expect(res.status).toBe(400);
  });

  it('returns the decoded row with satisfaction progress', async () => {
    await seedRow();
    const res = await GET(makeCtx(ROW_ID));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // Identity fields.
    expect(body.id).toBe(ROW_ID);
    expect(body.drepId).toBe(DREP_ID);
    expect(body.action).toBe('vote');

    // Action params decoded.
    expect(body.gaId).toBe(GA_ID);
    expect(body.vote).toBe(VOTE);
    expect(body.anchorUrl).toBeNull();

    // Status.
    expect(body.status).toBe('collecting');
    expect(body.txHash).toBeNull();

    // Progress: 1 of 3 leaves signed, threshold 2, not satisfied yet.
    expect(body.satisfied).toBe(false);
    expect(body.signedLeaves).toBe(1);
    expect(body.totalLeaves).toBe(3);
    expect(body.threshold).toBe(2);

    // Signers list contains the one witness key hash.
    expect(Array.isArray(body.signers)).toBe(true);
    expect(body.signers).toContain(KEY_A);

    // Co-signer payload.
    expect(body.unsignedTxCbor).toBe(TX_CBOR);
    expect(body.bodyHash).toBe(BODY_HASH);

    // Expiry.
    expect(typeof body.expiresAt).toBe('number');
  });
});
