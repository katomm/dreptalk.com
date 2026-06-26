/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for POST /api/drep/multisig/[id]/submit.
// The endpoint re-checks satisfaction, folds collected witnesses into the
// unsigned tx, and returns { assembledTxHex }. It does NOT call the chain.
//
// Satisfied-fold path: Transaction.addVKeyWitnessesHex is vi.mocked so we
// can verify that (a) satisfaction is checked with the REAL isNativeScriptSatisfied
// (real key-hash witnesses seed real sig leaves), and (b) the fold runs and its
// output is returned. The mock returns a sentinel so we can assert round-trip
// without a parseable real tx CBOR.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { TransactionWitnessSet, VKey, Ed25519Signature } from '@evolution-sdk/evolution';
import { bytesToHex, hexToBytes } from '@/lib/crypto/hex';
import { parseNativeScriptJson, nativeScriptHash } from '@/lib/cardano/nativeScript';
import { encodeBech32 } from '@/lib/crypto/bech32';
import { DREP_SCRIPT_HEADER } from '@/lib/cardano/identity';
import { createPendingMultisig } from '@/lib/db/pendingMultisigTx';

// ---------------------------------------------------------------------------
// Mock Transaction.addVKeyWitnessesHex to avoid needing a real tx CBOR.
// The satisfaction check uses real key hashes so isNativeScriptSatisfied is
// exercised genuinely.
// ---------------------------------------------------------------------------

const ASSEMBLED_SENTINEL = 'ASSEMBLED_SENTINEL_HEX';

vi.mock('@evolution-sdk/evolution', async (importOriginal) => {
  const original = await importOriginal<typeof import('@evolution-sdk/evolution')>();
  return {
    ...original,
    Transaction: {
      ...original.Transaction,
      addVKeyWitnessesHex: vi.fn(() => ASSEMBLED_SENTINEL),
    },
  };
});

// Import AFTER vi.mock so the mock is active when the module loads.
const { POST } = await import('./submit');

// ---------------------------------------------------------------------------
// Key fixtures: 2-of-3 atLeast native script.
// ---------------------------------------------------------------------------

const PRIV_A = hexToBytes('a1'.repeat(32));
const PRIV_B = hexToBytes('b2'.repeat(32));
const PRIV_C = hexToBytes('c3'.repeat(32));

const PUB_A = ed25519.getPublicKey(PRIV_A);
const PUB_B = ed25519.getPublicKey(PRIV_B);
const PUB_C = ed25519.getPublicKey(PRIV_C);

const KEY_HASH_A = bytesToHex(blake2b(PUB_A, { dkLen: 28 }));
const KEY_HASH_B = bytesToHex(blake2b(PUB_B, { dkLen: 28 }));
const KEY_HASH_C = bytesToHex(blake2b(PUB_C, { dkLen: 28 }));

const SCRIPT_VALUE = {
  type: 'atLeast',
  required: 2,
  scripts: [
    { type: 'sig', keyHash: KEY_HASH_A },
    { type: 'sig', keyHash: KEY_HASH_B },
    { type: 'sig', keyHash: KEY_HASH_C },
  ],
};
const PARSED_SCRIPT = parseNativeScriptJson(SCRIPT_VALUE)!;
const SCRIPT_HASH = nativeScriptHash(PARSED_SCRIPT);

function scriptDrepIdFromHash(hashHex: string): string {
  const payload = new Uint8Array(29);
  payload[0] = DREP_SCRIPT_HEADER;
  payload.set(hexToBytes(hashHex), 1);
  return encodeBech32('drep', payload);
}

const SCRIPT_DREP_ID = scriptDrepIdFromHash(SCRIPT_HASH);

// Build a witness-set CBOR hex for a given private key + body hash.
function makeWitnessHex(priv: Uint8Array, bodyHash: Uint8Array): { hex: string; keyHashHex: string } {
  const pub = ed25519.getPublicKey(priv);
  const sig = ed25519.sign(bodyHash, priv);
  const ws = TransactionWitnessSet.fromVKeyWitnesses([
    new TransactionWitnessSet.VKeyWitness({ vkey: VKey.fromBytes(pub), signature: Ed25519Signature.fromBytes(sig) }),
  ]);
  const keyHashHex = bytesToHex(blake2b(pub, { dkLen: 28 }));
  return { hex: TransactionWitnessSet.toCBORHex(ws), keyHashHex };
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const ROW_ID = 'submit-test-row-001';
const GA_ID = `${'a'.repeat(64)}#0`;
const TX_CBOR = 'e'.repeat(128);
const BODY_HASH = 'f'.repeat(64);
const MEMBER_USER_ID = 'member-user-submit-1';
const OTHER_USER_ID = 'other-user-submit-2';
// Use a NOW far enough in the future that expiresAt = NOW + 86400 is still a
// future time when the test runs. 2030-01-01T00:00:00Z in unix seconds.
const NOW = 1_893_456_000;

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
  expiresAt: number;
  witnesses: string;
  status: string;
}> = {}) {
  const id = overrides.id ?? ROW_ID;
  await createPendingMultisig(env.DB, {
    id,
    drepId: SCRIPT_DREP_ID,
    action: 'vote',
    actionParams: JSON.stringify({ gaId: GA_ID, vote: 'yes' }),
    unsignedTxCbor: TX_CBOR,
    bodyHash: BODY_HASH,
    nativeScript: JSON.stringify(SCRIPT_VALUE),
    createdBy: MEMBER_USER_ID,
    createdAt: NOW - 3600,
    expiresAt: overrides.expiresAt ?? NOW + 86400,
  });
  // Patch witnesses/status if needed.
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

// ---------------------------------------------------------------------------
// APIContext factory.
// ---------------------------------------------------------------------------

function makeCtx(opts: {
  user: { id: string; roles: string[] } | null;
  id: string | undefined;
}) {
  const url = `https://dreptalk.com/api/drep/multisig/${opts.id ?? ''}/submit`;
  const request = new Request(url, { method: 'POST' });
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
  vi.clearAllMocks();
});

describe('POST /api/drep/multisig/[id]/submit', () => {
  it('returns 401 when not logged in', async () => {
    const res = await POST(makeCtx({ user: null, id: ROW_ID }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when logged in without the drep role', async () => {
    const res = await POST(makeCtx({ user: { id: MEMBER_USER_ID, roles: ['proposer'] }, id: ROW_ID }));
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent row', async () => {
    await seedMemberUser();
    const res = await POST(makeCtx({ user: { id: MEMBER_USER_ID, roles: ['drep'] }, id: 'nonexistent-xyz' }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when the session user is not a member of this script DRep', async () => {
    await seedRow();
    await seedMemberUser(OTHER_USER_ID, scriptDrepIdFromHash('1'.repeat(56)));
    const res = await POST(makeCtx({ user: { id: OTHER_USER_ID, roles: ['drep'] }, id: ROW_ID }));
    expect(res.status).toBe(403);
  });

  it('returns 410 when the row is expired (even if witnesses satisfy)', async () => {
    // Seed two witnesses (satisfies 2-of-3) but expired row.
    // expiresAt must be strictly less than the real wall-clock time when the test
    // runs, so we use a well-known past unix timestamp (2020-01-01).
    const PAST_EXPIRES_AT = 1_577_836_800;
    const wA = makeWitnessHex(PRIV_A, hexToBytes(BODY_HASH));
    const wB = makeWitnessHex(PRIV_B, hexToBytes(BODY_HASH));
    const witnesses = JSON.stringify([
      { key_hash: wA.keyHashHex, witness_hex: wA.hex },
      { key_hash: wB.keyHashHex, witness_hex: wB.hex },
    ]);
    await seedRow({ expiresAt: PAST_EXPIRES_AT, witnesses });
    await seedMemberUser();
    const res = await POST(makeCtx({ user: { id: MEMBER_USER_ID, roles: ['drep'] }, id: ROW_ID }));
    expect(res.status).toBe(410);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('expired');
  });

  it('returns 409 when only 1 of 3 witnesses are present (not yet satisfied)', async () => {
    const wA = makeWitnessHex(PRIV_A, hexToBytes(BODY_HASH));
    const witnesses = JSON.stringify([{ key_hash: wA.keyHashHex, witness_hex: wA.hex }]);
    await seedRow({ witnesses });
    await seedMemberUser();
    const res = await POST(makeCtx({ user: { id: MEMBER_USER_ID, roles: ['drep'] }, id: ROW_ID }));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('not yet satisfied');
  });

  it('returns 409 when 0 witnesses are present (not yet satisfied)', async () => {
    await seedRow({ witnesses: '[]' });
    await seedMemberUser();
    const res = await POST(makeCtx({ user: { id: MEMBER_USER_ID, roles: ['drep'] }, id: ROW_ID }));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('not yet satisfied');
  });

  it('returns 409 when status is not collecting', async () => {
    const wA = makeWitnessHex(PRIV_A, hexToBytes(BODY_HASH));
    const wB = makeWitnessHex(PRIV_B, hexToBytes(BODY_HASH));
    const witnesses = JSON.stringify([
      { key_hash: wA.keyHashHex, witness_hex: wA.hex },
      { key_hash: wB.keyHashHex, witness_hex: wB.hex },
    ]);
    await seedRow({ witnesses, status: 'submitted' });
    await seedMemberUser();
    const res = await POST(makeCtx({ user: { id: MEMBER_USER_ID, roles: ['drep'] }, id: ROW_ID }));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('no longer collecting');
  });

  it('returns 200 with assembledTxHex when 2-of-3 witnesses satisfy the script', async () => {
    // Seed real witnesses using real key hashes from the 2-of-3 script leaves.
    const wA = makeWitnessHex(PRIV_A, hexToBytes(BODY_HASH));
    const wB = makeWitnessHex(PRIV_B, hexToBytes(BODY_HASH));
    const witnesses = JSON.stringify([
      { key_hash: wA.keyHashHex, witness_hex: wA.hex },
      { key_hash: wB.keyHashHex, witness_hex: wB.hex },
    ]);
    await seedRow({ witnesses });
    await seedMemberUser();

    const res = await POST(makeCtx({ user: { id: MEMBER_USER_ID, roles: ['drep'] }, id: ROW_ID }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // The mock returns ASSEMBLED_SENTINEL (two folds -> still the sentinel return value).
    expect(body.assembledTxHex).toBe(ASSEMBLED_SENTINEL);

    // Verify Transaction.addVKeyWitnessesHex was called twice (once per witness).
    const { Transaction } = await import('@evolution-sdk/evolution');
    expect(Transaction.addVKeyWitnessesHex).toHaveBeenCalledTimes(2);
    // First call starts from the unsigned tx CBOR.
    expect(Transaction.addVKeyWitnessesHex).toHaveBeenNthCalledWith(1, TX_CBOR, wA.hex);
    // Second call folds on top of whatever the first returned.
    expect(Transaction.addVKeyWitnessesHex).toHaveBeenNthCalledWith(2, ASSEMBLED_SENTINEL, wB.hex);
  });
});
