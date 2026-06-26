/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/drep/multisig/[id]/submitted.
// After the browser folds the funding-input witness and submits the tx, it
// POSTs the resulting txHash here to mark the row submitted and record the
// local vote in drep_votes.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { TransactionWitnessSet, VKey, Ed25519Signature } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '@/lib/crypto/hex';
import { parseNativeScriptJson, nativeScriptHash } from '@/lib/cardano/nativeScript';
import { encodeBech32 } from '@/lib/crypto/bech32';
import { DREP_SCRIPT_HEADER } from '@/lib/cardano/identity';
import { createPendingMultisig, getPendingMultisig } from '@/lib/db/pendingMultisigTx';
import { POST } from './submitted';

// ---------------------------------------------------------------------------
// Key fixtures: a simple 2-sig "any" script.
// ---------------------------------------------------------------------------

const PRIV_A = hexToBytes('d4'.repeat(32));
const PRIV_B = hexToBytes('e5'.repeat(32));

const PUB_A = ed25519.getPublicKey(PRIV_A);
const PUB_B = ed25519.getPublicKey(PRIV_B);

const KEY_HASH_A = bytesToHex(blake2b(PUB_A, { dkLen: 28 }));
const KEY_HASH_B = bytesToHex(blake2b(PUB_B, { dkLen: 28 }));

const SCRIPT_VALUE = {
  type: 'any',
  scripts: [
    { type: 'sig', keyHash: KEY_HASH_A },
    { type: 'sig', keyHash: KEY_HASH_B },
  ],
};
const PARSED_SCRIPT = parseNativeScriptJson(SCRIPT_VALUE)!;
const SCRIPT_HASH = nativeScriptHash(PARSED_SCRIPT);

// Suppress unused-variable warning; PARSED_SCRIPT referenced via side-effect above.
void PARSED_SCRIPT;

function scriptDrepIdFromHash(hashHex: string): string {
  const payload = new Uint8Array(29);
  payload[0] = DREP_SCRIPT_HEADER;
  payload.set(hexToBytes(hashHex), 1);
  return encodeBech32('drep', payload);
}

const SCRIPT_DREP_ID = scriptDrepIdFromHash(SCRIPT_HASH);

// Minimal witness hex builder (not used for crypto checks here, just for seeding).
function makeWitnessHex(priv: Uint8Array, bodyHashHex: string): { hex: string; keyHashHex: string } {
  const pub = ed25519.getPublicKey(priv);
  const sig = ed25519.sign(hexToBytes(bodyHashHex), priv);
  const ws = TransactionWitnessSet.fromVKeyWitnesses([
    new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromBytes(pub), signature: Ed25519Signature.fromBytes(sig) }),
  ]);
  return { hex: TransactionWitnessSet.toCBORHex(ws), keyHashHex: bytesToHex(blake2b(pub, { dkLen: 28 })) };
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const ROW_ID = 'submitted-test-row-001';
const GA_ID = `${'1'.repeat(64)}#0`;
const ANCHOR_URL = 'https://example.com/rationale.jsonld';
const TX_CBOR = '0'.repeat(128);
const BODY_HASH = '9'.repeat(64);
const VALID_TX_HASH = 'a'.repeat(64);
const MEMBER_USER_ID = 'member-user-submitted-1';
const OTHER_USER_ID = 'other-user-submitted-2';
// Use a NOW far enough in the future that expiresAt = NOW + 86400 is still a
// future time when the test runs. 2030-01-01T00:00:00Z + 100 seconds.
const NOW = 1_893_456_100;

// ---------------------------------------------------------------------------
// DB seed helpers.
// ---------------------------------------------------------------------------

async function seedMemberUser(userId = MEMBER_USER_ID, drepId = SCRIPT_DREP_ID) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, drep_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, 1, 0, 0, 0, 'drep', 'active', ?, ?)`,
  )
    .bind(userId, drepId, NOW, NOW)
    .run();
}

async function seedRow(overrides: Partial<{
  id: string;
  witnesses: string;
  status: string;
  actionParams: string;
}> = {}) {
  const id = overrides.id ?? ROW_ID;
  await createPendingMultisig(env.DB, {
    id,
    drepId: SCRIPT_DREP_ID,
    action: 'vote',
    actionParams: overrides.actionParams ?? JSON.stringify({ gaId: GA_ID, vote: 'yes', anchorUrl: ANCHOR_URL }),
    unsignedTxCbor: TX_CBOR,
    bodyHash: BODY_HASH,
    nativeScript: JSON.stringify(SCRIPT_VALUE),
    createdBy: MEMBER_USER_ID,
    createdAt: NOW - 3600,
    expiresAt: NOW + 86400,
  });
  if (overrides.witnesses !== undefined) {
    await env.DB.prepare('UPDATE pending_multisig_tx SET witnesses = ? WHERE id = ?')
      .bind(overrides.witnesses, id)
      .run();
  }
  if (overrides.status !== undefined) {
    await env.DB.prepare("UPDATE pending_multisig_tx SET status = ? WHERE id = ?")
      .bind(overrides.status, id)
      .run();
  }
}

async function seedSatisfiedRow(id = ROW_ID) {
  const wA = makeWitnessHex(PRIV_A, BODY_HASH);
  const witnesses = JSON.stringify([{ key_hash: wA.keyHashHex, witness_hex: wA.hex }]);
  await seedRow({ id, witnesses });
}

// ---------------------------------------------------------------------------
// APIContext factory.
// ---------------------------------------------------------------------------

function makeCtx(opts: {
  user: { id: string; roles: string[] } | null;
  id: string | undefined;
  body: Record<string, unknown>;
}) {
  const url = `https://dreptalk.com/api/drep/multisig/${opts.id ?? ''}/submitted`;
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  const locals = { user: opts.user } as unknown as App.Locals;
  const params = opts.id !== undefined ? { id: opts.id } : {};
  return { request, locals, params } as Parameters<typeof POST>[0];
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM pending_multisig_tx').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM drep_votes').run();
});

describe('POST /api/drep/multisig/[id]/submitted', () => {
  it('returns 401 when not logged in', async () => {
    const res = await POST(makeCtx({ user: null, id: ROW_ID, body: { txHash: VALID_TX_HASH } }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when logged in without the drep role', async () => {
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['proposer'] },
      id: ROW_ID,
      body: { txHash: VALID_TX_HASH },
    }));
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent row', async () => {
    await seedMemberUser();
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: 'nonexistent-xyz',
      body: { txHash: VALID_TX_HASH },
    }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when the session user is not a member of this script DRep', async () => {
    await seedSatisfiedRow();
    await seedMemberUser(OTHER_USER_ID, scriptDrepIdFromHash('2'.repeat(56)));
    const res = await POST(makeCtx({
      user: { id: OTHER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { txHash: VALID_TX_HASH },
    }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when txHash is missing', async () => {
    await seedSatisfiedRow();
    await seedMemberUser();
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: {},
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash is not a 64-char hex string', async () => {
    await seedSatisfiedRow();
    await seedMemberUser();
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { txHash: 'not-a-tx-hash' },
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when txHash is too short', async () => {
    await seedSatisfiedRow();
    await seedMemberUser();
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { txHash: 'abc123' },
    }));
    expect(res.status).toBe(400);
  });

  it('returns 409 when the row is already submitted (idempotency guard)', async () => {
    await seedSatisfiedRow();
    await env.DB.prepare("UPDATE pending_multisig_tx SET status = 'submitted', tx_hash = ? WHERE id = ?")
      .bind(VALID_TX_HASH, ROW_ID)
      .run();
    await seedMemberUser();
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { txHash: VALID_TX_HASH },
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('already submitted');
  });

  it('marks the row submitted with the txHash and inserts into drep_votes', async () => {
    await seedSatisfiedRow();
    await seedMemberUser();

    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { txHash: VALID_TX_HASH },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // Verify the pending_multisig_tx row is now status 'submitted' with the tx hash.
    const row = await getPendingMultisig(env.DB, ROW_ID);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('submitted');
    expect(row!.tx_hash).toBe(VALID_TX_HASH);

    // Verify drep_votes has a row for this gaId / drepId.
    const vote = await env.DB.prepare(
      `SELECT vote, voter_id, voter_role, tx_hash, local_status, meta_url FROM drep_votes
       WHERE ga_id = ? AND voter_id = ? AND voter_role = 'DRep'`,
    )
      .bind(GA_ID, SCRIPT_DREP_ID)
      .first<{ vote: string; voter_id: string; voter_role: string; tx_hash: string; local_status: string; meta_url: string | null }>();
    expect(vote).not.toBeNull();
    expect(vote!.vote).toBe('yes');
    expect(vote!.tx_hash).toBe(VALID_TX_HASH);
    expect(vote!.local_status).toBe('pending');
    expect(vote!.meta_url).toBe(ANCHOR_URL);
  });

  it('records a local vote without anchorUrl when action_params has no anchorUrl', async () => {
    await seedRow({ actionParams: JSON.stringify({ gaId: GA_ID, vote: 'no' }) });
    const wA = makeWitnessHex(PRIV_A, BODY_HASH);
    await env.DB.prepare('UPDATE pending_multisig_tx SET witnesses = ? WHERE id = ?')
      .bind(JSON.stringify([{ key_hash: wA.keyHashHex, witness_hex: wA.hex }]), ROW_ID)
      .run();
    await seedMemberUser();

    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { txHash: VALID_TX_HASH },
    }));
    expect(res.status).toBe(200);

    const vote = await env.DB.prepare(
      `SELECT vote, meta_url FROM drep_votes WHERE ga_id = ? AND voter_id = ? AND voter_role = 'DRep'`,
    )
      .bind(GA_ID, SCRIPT_DREP_ID)
      .first<{ vote: string; meta_url: string | null }>();
    expect(vote).not.toBeNull();
    expect(vote!.vote).toBe('no');
    expect(vote!.meta_url).toBeNull();
  });
});
