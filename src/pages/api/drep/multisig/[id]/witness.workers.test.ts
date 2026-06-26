/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/drep/multisig/[id]/witness.
// Calls the exported POST handler directly with a synthetic APIContext so
// the test runs inside the real Workers runtime (D1 via cloudflare:test)
// without needing an HTTP server or the Astro middleware chain.
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
import { POST } from './witness';

// ---------------------------------------------------------------------------
// Helper: build a witness-set CBOR hex from a private key + body hash.
// ---------------------------------------------------------------------------

function makeWitnessSetHex(priv: Uint8Array, bodyHash: Uint8Array): { hex: string; keyHashHex: string } {
  const pub = ed25519.getPublicKey(priv);
  const sig = ed25519.sign(bodyHash, priv);
  const ws = TransactionWitnessSet.fromVKeyWitnesses([
    new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromBytes(pub), signature: Ed25519Signature.fromBytes(sig) }),
  ]);
  const keyHashHex = bytesToHex(blake2b(pub, { dkLen: 28 }));
  return { hex: TransactionWitnessSet.toCBORHex(ws), keyHashHex };
}

// ---------------------------------------------------------------------------
// Script fixture: a 2-sig "any" script with two known member keys.
// MEMBER_PRIV_A is a valid signer; OUTSIDER_PRIV is not a leaf.
// ---------------------------------------------------------------------------

const MEMBER_PRIV_A = hexToBytes('01'.repeat(32));
const MEMBER_PUB_A = ed25519.getPublicKey(MEMBER_PRIV_A);
const MEMBER_KEY_HASH_A = bytesToHex(blake2b(MEMBER_PUB_A, { dkLen: 28 }));

const MEMBER_PRIV_B = hexToBytes('02'.repeat(32));
const MEMBER_PUB_B = ed25519.getPublicKey(MEMBER_PRIV_B);
const MEMBER_KEY_HASH_B = bytesToHex(blake2b(MEMBER_PUB_B, { dkLen: 28 }));

const OUTSIDER_PRIV = hexToBytes('ff'.repeat(32));

const SCRIPT_VALUE = {
  type: 'any',
  scripts: [
    { type: 'sig', keyHash: MEMBER_KEY_HASH_A },
    { type: 'sig', keyHash: MEMBER_KEY_HASH_B },
  ],
};
const PARSED_SCRIPT = parseNativeScriptJson(SCRIPT_VALUE)!;
const SCRIPT_HASH = nativeScriptHash(PARSED_SCRIPT);

// Build script DRep bech32 id from hash.
function scriptDrepIdFromHash(hashHex: string): string {
  const payload = new Uint8Array(29);
  payload[0] = DREP_SCRIPT_HEADER;
  payload.set(hexToBytes(hashHex), 1);
  return encodeBech32('drep', payload);
}

const SCRIPT_DREP_ID = scriptDrepIdFromHash(SCRIPT_HASH);

const ROW_ID = 'test-witness-row-001';
const GA_ID = `${'b'.repeat(64)}#0`;
const TX_CBOR = 'c'.repeat(128);
const BODY_HASH = 'd'.repeat(64);
const MEMBER_USER_ID = 'member-user-witness-1';
const OTHER_USER_ID = 'other-user-witness-2';
const NOW = 1_752_100_000;

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

async function seedRow(id = ROW_ID) {
  await createPendingMultisig(env.DB, {
    id,
    drepId: SCRIPT_DREP_ID,
    action: 'vote',
    actionParams: JSON.stringify({ gaId: GA_ID, vote: 'yes' }),
    unsignedTxCbor: TX_CBOR,
    bodyHash: BODY_HASH,
    nativeScript: JSON.stringify(SCRIPT_VALUE),
    createdBy: MEMBER_USER_ID,
    createdAt: NOW,
    expiresAt: NOW + 86400,
  });
}

// ---------------------------------------------------------------------------
// Synthetic APIContext builder.
// ---------------------------------------------------------------------------

function makeCtx(opts: {
  user: { id: string; roles: string[] } | null;
  id: string | undefined;
  body: Record<string, unknown>;
}) {
  const url = `https://dreptalk.com/api/drep/multisig/${opts.id ?? ''}/witness`;
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.body),
  });
  const locals = { user: opts.user } as unknown as App.Locals;
  const params = opts.id !== undefined ? { id: opts.id } : {};
  return { request, locals, params } as Parameters<typeof POST>[0];
}

beforeEach(async () => {
  // Clean the table before each test to avoid collisions across tests.
  await env.DB.prepare('DELETE FROM pending_multisig_tx').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('POST /api/drep/multisig/[id]/witness', () => {
  it('returns 401 when not logged in', async () => {
    const res = await POST(makeCtx({ user: null, id: ROW_ID, body: { witnessSetHex: '00' } }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when logged in without the drep role', async () => {
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['proposer'] },
      id: ROW_ID,
      body: { witnessSetHex: '00' },
    }));
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent row', async () => {
    await seedMemberUser();
    const { hex } = makeWitnessSetHex(MEMBER_PRIV_A, hexToBytes(BODY_HASH));
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: 'nonexistent-row-xyz',
      body: { witnessSetHex: hex },
    }));
    expect(res.status).toBe(404);
  });

  it('returns 403 for a session user whose drep_id does not match the row', async () => {
    // Seed the row first, then a user with a DIFFERENT drep_id.
    await seedRow();
    await seedMemberUser(OTHER_USER_ID, scriptDrepIdFromHash('e'.repeat(56)));
    const { hex } = makeWitnessSetHex(MEMBER_PRIV_A, hexToBytes(BODY_HASH));
    const res = await POST(makeCtx({
      user: { id: OTHER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: hex },
    }));
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('not a member');
  });

  it('returns 422 for a witness whose key is not a script leaf', async () => {
    await seedRow();
    await seedMemberUser();
    const { hex } = makeWitnessSetHex(OUTSIDER_PRIV, hexToBytes(BODY_HASH));
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: hex },
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("That key is not one of this DRep's authorized signers.");
  });

  it('returns 200 with updated progress for a valid member witness', async () => {
    await seedRow();
    await seedMemberUser();
    const { hex } = makeWitnessSetHex(MEMBER_PRIV_A, hexToBytes(BODY_HASH));
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: hex },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.satisfied).toBe('boolean');
    expect(typeof body.signedLeaves).toBe('number');
    expect(body.signedLeaves).toBeGreaterThanOrEqual(1);

    // Verify the witness was persisted to D1.
    const row = await getPendingMultisig(env.DB, ROW_ID);
    expect(row).not.toBeNull();
    const witnesses = JSON.parse(row!.witnesses) as Array<{ key_hash: string; witness_hex: string }>;
    expect(witnesses.length).toBe(1);
    expect(witnesses[0].key_hash).toBe(MEMBER_KEY_HASH_A);
  });

  it('returns 409 for a duplicate witness (same key posted twice)', async () => {
    await seedRow();
    await seedMemberUser();
    const { hex } = makeWitnessSetHex(MEMBER_PRIV_A, hexToBytes(BODY_HASH));

    // First POST should succeed.
    const first = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: hex },
    }));
    expect(first.status).toBe(200);

    // Second POST with the same witness should be 409.
    const second = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: hex },
    }));
    expect(second.status).toBe(409);
    const body = await second.json() as Record<string, unknown>;
    expect(body.error).toBe('This signer has already added a witness.');
  });

  it('returns 400 when witnessSetHex fails zod validation', async () => {
    await seedRow();
    await seedMemberUser();
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: '' },
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when witnessSetHex is not hex', async () => {
    await seedRow();
    await seedMemberUser();
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: 'not-hex!!' },
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when the witness set contains zero signatures', async () => {
    await seedRow();
    await seedMemberUser();
    // Build an empty witness set.
    const emptyWs = TransactionWitnessSet.fromVKeyWitnesses([]);
    const emptyHex = TransactionWitnessSet.toCBORHex(emptyWs);
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: emptyHex },
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('expected exactly one signature');
  });

  it('returns 400 when the witness set contains more than one signature', async () => {
    await seedRow();
    await seedMemberUser();
    // Build a witness set with two signatures.
    const sig1 = makeWitnessSetHex(MEMBER_PRIV_A, hexToBytes(BODY_HASH));
    const sig2 = makeWitnessSetHex(MEMBER_PRIV_B, hexToBytes(BODY_HASH));
    // Parse both and recombine into one multi-witness set.
    const pubA = ed25519.getPublicKey(MEMBER_PRIV_A);
    const pubB = ed25519.getPublicKey(MEMBER_PRIV_B);
    const sigA = ed25519.sign(hexToBytes(BODY_HASH), MEMBER_PRIV_A);
    const sigB = ed25519.sign(hexToBytes(BODY_HASH), MEMBER_PRIV_B);
    const ws = TransactionWitnessSet.fromVKeyWitnesses([
      new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromBytes(pubA), signature: Ed25519Signature.fromBytes(sigA) }),
      new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromBytes(pubB), signature: Ed25519Signature.fromBytes(sigB) }),
    ]);
    // Silence the unused-var lint hint.
    void sig1;
    void sig2;
    const multiHex = TransactionWitnessSet.toCBORHex(ws);
    const res = await POST(makeCtx({
      user: { id: MEMBER_USER_ID, roles: ['drep'] },
      id: ROW_ID,
      body: { witnessSetHex: multiHex },
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('expected exactly one signature');
  });
});
