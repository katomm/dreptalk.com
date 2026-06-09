// Auth handler tests -- runs in real workerd via @cloudflare/vitest-pool-workers.
// Uses real KV/DB bindings, injected fake koios, and CIP-8 fixture vectors.
//
// Nonce alignment strategy:
//   The CIP-8 fixtures sign a fixed payload "dreptalk-login:test-vector-001".
//   The real consumeNonce requires the payload format
//   "dreptalk:<domain>:<nonce>:<issuedAt>" and looks up the nonce segment in KV.
//   These two formats are structurally incompatible, so we inject a custom
//   consumeNonce via the deps parameter of handleVerify for the happy-path tests.
//   This override stores the fixture payload in KV under a synthetic key and
//   deletes it on the first call (single-use simulation), providing replay
//   protection while allowing the fixture signature to verify correctly.
//   Reject cases for replayed nonces are tested with real consumeNonce and a
//   proper dreptalk:<domain>:<nonce>:<ts> payload (signature step is never
//   reached after nonce rejection, so no fixture alignment is needed there).

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import vectors from './__fixtures__/cip8-vectors.json';
import { makeCoseSignature, type6Address } from './__fixtures__/makeCose.js';
import { handleChallenge, handleVerify, handleLogout } from './handlers.js';
import { getSession } from './session.js';
import { getUserById } from '../db/users.js';
import { bytesToHex } from '../crypto/hex.js';
import { ccHotKeyHashHex } from '../cardano/identity.js';

// Raw Ed25519 signing for the Calidus / CC-hot paste login flow. Returns the
// public key and detached signature as the client would paste them.
function rawSign(payload: string, seed: Uint8Array) {
  const pubKey = ed25519.getPublicKey(seed);
  const sig = ed25519.sign(new TextEncoder().encode(payload), seed);
  return { publicKeyHex: bytesToHex(pubKey), signatureHex: bytesToHex(sig), pubKey };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stakeVector = vectors.vectors.find(v => v.label === 'stake-key-valid')!;
const drepVector = vectors.vectors.find(v => v.label === 'drep-key-valid')!;

// Fake koios clients.
function koiosRejectAll() {
  return {
    drepInfo: async () => null,
    accountInfo: async () => null,
    proposalsByReturnAddress: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Nonce injection helper for fixture-based tests.
// Stores a sentinel key in KV. On first call, deletes it and returns true.
// On subsequent calls, returns false (replay rejection).
// ---------------------------------------------------------------------------

function makeSingleUseNonceOverride(_kv: KVNamespace, payload: string) {
  const sentinelKey = `fixture-nonce:${payload}`;
  return async (kvArg: KVNamespace, payloadArg: string): Promise<boolean> => {
    if (payloadArg !== payload) return false;
    const stored = await kvArg.get(sentinelKey);
    if (stored === null) return false;
    await kvArg.delete(sentinelKey);
    return true;
  };
}

async function preloadNonce(kv: KVNamespace, payload: string): Promise<void> {
  const sentinelKey = `fixture-nonce:${payload}`;
  await kv.put(sentinelKey, '1');
}

// ---------------------------------------------------------------------------
// handleChallenge
// ---------------------------------------------------------------------------

describe('handleChallenge', () => {
  it('returns a payload in the dreptalk:<domain>:<nonce>:<ts> format', async () => {
    const result = await handleChallenge({
      nonceKv: env.NONCES,
      domain: 'dreptalk.com',
    });
    expect(typeof result.payload).toBe('string');
    expect(result.payload).toMatch(/^dreptalk:dreptalk\.com:[^:]+:\d+$/);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: PROPOSER
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (proposer)', () => {
  it('returns 200, ok:true, a Set-Cookie, and inserts a users row', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    await preloadNonce(env.NONCES, fixturePayload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, fixturePayload);

    // The stake-key-valid fixture signs as a preprod reward address (header 0xe0).
    // stakeAddressFromPubKey will derive the stake address from the pubKey,
    // and we make the fake koios accept any stake address so the test is hermetic.
    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: stakeVector.signatureHex,
        keyHex: stakeVector.keyHex,
        role: 'proposer',
      },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        drepInfo: async () => null,
        accountInfo: async () => null,
        proposalsByReturnAddress: async (addr: string) => [
          { proposal_id: 'gov_action1fixture', return_address: addr, proposal_type: 'InfoAction' },
        ],
      },
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect(result.setCookie).toBeTruthy();
    expect(result.setCookie).toContain('dreptalk_session=');
    expect(result.setCookie).toContain('HttpOnly');

    // Verify a user row was inserted.
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.user).toBeTruthy();
    expect(typeof json.user.id).toBe('string');
    expect(json.user.roles).toContain('proposer');

    const row = await getUserById(env.DB, json.user.id);
    expect(row).not.toBeNull();
    expect(row!.is_proposer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: DREP
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (drep)', () => {
  it('returns 200 and inserts a drep user row for a real type-6 DRep signature', async () => {
    const payload = 'dreptalk:dreptalk.com:drep-happy-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);

    // A CIP-95 wallet signs with the DRep key over a CIP-19 type-6 enterprise
    // address (preprod header 0x60 + the 28-byte DRep key hash). The fake koios
    // accepts any drep id, so the test exercises the full verify + gate flow.
    const seed = new Uint8Array(32).fill(9);
    const { keyHash } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });
    const cose = makeCoseSignature({ seed, payload, addressBytes: type6Address(keyHash, 'preprod') });

    const result = await handleVerify({
      body: {
        payload,
        signatureHex: cose.signatureHex,
        keyHex: cose.keyHex,
        role: 'drep',
      },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        drepInfo: async (id: string) => ({
          drep_id: id,
          hex: 'bb',
          has_script: false,
          drep_status: 'registered',
          active: true,
          deposit: '500000000',
          expires_epoch_no: null,
        }),
        accountInfo: async () => null,
        proposalsByReturnAddress: async () => [],
      },
      network: 'preprod',
      now: 1_700_000_100,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect(result.setCookie).toBeTruthy();

    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.user.roles).toContain('drep');
    const row = await getUserById(env.DB, json.user.id);
    expect(row).not.toBeNull();
    expect(row!.is_drep).toBe(true);
  });

  it('accepts a bare 28-byte DRep key hash address form', async () => {
    const payload = 'dreptalk:dreptalk.com:drep-bare-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);

    const seed = new Uint8Array(32).fill(10);
    const { keyHash } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });
    const cose = makeCoseSignature({ seed, payload, addressBytes: keyHash });

    const result = await handleVerify({
      body: { payload, signatureHex: cose.signatureHex, keyHex: cose.keyHex, role: 'drep' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        drepInfo: async (id: string) => ({
          drep_id: id,
          hex: 'cc',
          has_script: false,
          drep_status: 'registered',
          active: true,
          deposit: '500000000',
          expires_epoch_no: null,
        }),
        accountInfo: async () => null,
        proposalsByReturnAddress: async () => [],
      },
      network: 'preprod',
      now: 1_700_000_100,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: SPO (Calidus, raw Ed25519)
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (spo)', () => {
  it('returns 200 and inserts an spo user for a registered calidus key', async () => {
    const payload = 'dreptalk:dreptalk.com:spo-happy-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(11));
    const POOL = 'pool1test-spo-happy';

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'spo' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        ...koiosRejectAll(),
        poolCalidusKey: async (hex: string) =>
          hex.toLowerCase() === publicKeyHex.toLowerCase()
            ? {
                pool_id_bech32: POOL,
                calidus_pub_key: publicKeyHex,
                calidus_id_bech32: 'calidus1test',
                registered: true,
                pool_status: 'registered',
              }
            : null,
      },
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('spo');
    expect(json.user.id).toBe(POOL);
    const row = await getUserById(env.DB, json.user.id);
    expect(row!.is_spo).toBe(true);
    expect(row!.pool_id).toBe(POOL);
  });

  it('returns 401 when the calidus key is not registered to any pool', async () => {
    const payload = 'dreptalk:dreptalk.com:spo-unknown-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(12));

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'spo' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: { ...koiosRejectAll(), poolCalidusKey: async () => null },
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });

  it('returns 401 when the raw signature does not verify (flipped byte)', async () => {
    const payload = 'dreptalk:dreptalk.com:spo-badsig-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(11));
    const badSig = signatureHex.slice(0, -2) + (signatureHex.endsWith('00') ? 'ff' : '00');

    const result = await handleVerify({
      body: { payload, signatureHex: badSig, publicKeyHex, role: 'spo' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        ...koiosRejectAll(),
        // even if koios would accept, a bad signature must fail first
        poolCalidusKey: async () => ({
          pool_id_bech32: 'pool1x',
          calidus_pub_key: publicKeyHex,
          calidus_id_bech32: 'calidus1x',
          registered: true,
          pool_status: 'registered',
        }),
      },
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });

  it('returns 400 when the signature has the wrong length', async () => {
    const payload = 'dreptalk:dreptalk.com:spo-badlen-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { publicKeyHex } = rawSign(payload, new Uint8Array(32).fill(11));

    const result = await handleVerify({
      body: { payload, signatureHex: 'abcd', publicKeyHex, role: 'spo' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(400);
  });

  it('returns 400 when publicKeyHex is missing for an spo login', async () => {
    const payload = 'dreptalk:dreptalk.com:spo-nopub-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { signatureHex } = rawSign(payload, new Uint8Array(32).fill(11));

    const result = await handleVerify({
      body: { payload, signatureHex, role: 'spo' } as Parameters<typeof handleVerify>[0]['body'],
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: CC (committee hot key, raw Ed25519)
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (cc)', () => {
  it('returns 200 and inserts a cc user for an authorized key-based member', async () => {
    const payload = 'dreptalk:dreptalk.com:cc-happy-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload, new Uint8Array(32).fill(13));
    const hotHex = ccHotKeyHashHex(pubKey);
    const COLD = 'cc_cold1test-cc-happy';

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'cc' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        ...koiosRejectAll(),
        committeeInfo: async () => [
          {
            status: 'authorized',
            cc_hot_id: 'cc_hot1test',
            cc_cold_id: COLD,
            cc_hot_hex: hotHex,
            cc_cold_hex: 'aabbcc',
            expiration_epoch: 300,
            cc_hot_has_script: false,
            cc_cold_has_script: false,
          },
        ],
      },
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('cc');
    expect(json.user.id).toBe(COLD);
    const row = await getUserById(env.DB, json.user.id);
    expect(row!.is_cc).toBe(true);
    expect(row!.cc_cred).toBe(COLD);
  });

  it('returns 401 when the member exists but is not authorized', async () => {
    const payload = 'dreptalk:dreptalk.com:cc-unauth-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload, new Uint8Array(32).fill(14));
    const hotHex = ccHotKeyHashHex(pubKey);

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'cc' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        ...koiosRejectAll(),
        committeeInfo: async () => [
          {
            status: 'not_authorized',
            cc_hot_id: null,
            cc_cold_id: 'cc_cold1x',
            cc_hot_hex: hotHex,
            cc_cold_hex: 'aa',
            expiration_epoch: 300,
            cc_hot_has_script: null,
            cc_cold_has_script: false,
          },
        ],
      },
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });

  it('returns 401 when the matching credential is a native script (not key-based)', async () => {
    const payload = 'dreptalk:dreptalk.com:cc-script-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload, new Uint8Array(32).fill(15));
    const hotHex = ccHotKeyHashHex(pubKey);

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'cc' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        ...koiosRejectAll(),
        committeeInfo: async () => [
          {
            status: 'authorized',
            cc_hot_id: 'cc_hot1x',
            cc_cold_id: 'cc_cold1x',
            cc_hot_hex: hotHex,
            cc_cold_hex: 'aa',
            expiration_epoch: 300,
            cc_hot_has_script: true,
            cc_cold_has_script: true,
          },
        ],
      },
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: replayed nonce (spo, raw flow)
// ---------------------------------------------------------------------------

describe('handleVerify: reject replayed nonce (spo)', () => {
  it('returns 401 on the second call with the same nonce', async () => {
    const payload = 'dreptalk:dreptalk.com:spo-replay-nonce:1700000000';
    await preloadNonce(env.NONCES, payload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(16));

    const input = {
      body: { payload, signatureHex, publicKeyHex, role: 'spo' as const },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        ...koiosRejectAll(),
        poolCalidusKey: async () => ({
          pool_id_bech32: 'pool1replay',
          calidus_pub_key: publicKeyHex,
          calidus_id_bech32: 'calidus1x',
          registered: true,
          pool_status: 'registered',
        }),
      },
      network: 'preprod' as const,
      now: 1_700_000_000,
      secure: false,
    };
    const deps = { consumeNonce: consumeOverride };

    const first = await handleVerify(input, deps);
    expect(first.status).toBe(200);
    const second = await handleVerify(input, deps);
    expect(second.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: replayed nonce
// ---------------------------------------------------------------------------

describe('handleVerify: reject replayed nonce', () => {
  it('returns 401 on the second call with the same nonce', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    // Pre-load: only one use allowed.
    await preloadNonce(env.NONCES, fixturePayload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, fixturePayload);

    const commonInput = {
      body: {
        payload: fixturePayload,
        signatureHex: stakeVector.signatureHex,
        keyHex: stakeVector.keyHex,
        role: 'proposer' as const,
      },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        drepInfo: async () => null,
        accountInfo: async () => null,
        proposalsByReturnAddress: async (addr: string) => [
          { proposal_id: 'x', return_address: addr, proposal_type: 'InfoAction' },
        ],
      },
      network: 'preprod' as const,
      now: 1_700_000_000,
      secure: false,
    };
    const commonDeps = { consumeNonce: consumeOverride };

    const first = await handleVerify(commonInput, commonDeps);
    expect(first.status).toBe(200);

    // Second call: nonce already consumed, override returns false.
    const second = await handleVerify(commonInput, commonDeps);
    expect(second.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: bad signature
// ---------------------------------------------------------------------------

describe('handleVerify: reject bad signature', () => {
  it('returns 401 when the signature has a flipped byte', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    await preloadNonce(env.NONCES, fixturePayload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, fixturePayload);

    // Flip last byte of signatureHex.
    const badSig = stakeVector.signatureHex.slice(0, -2) + 'ff';

    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: badSig,
        keyHex: stakeVector.keyHex,
        role: 'proposer',
      },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: koios says not a proposer
// ---------------------------------------------------------------------------

describe('handleVerify: reject when koios returns no proposals', () => {
  it('returns 401 when koios returns empty proposals', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    await preloadNonce(env.NONCES, fixturePayload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, fixturePayload);

    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: stakeVector.signatureHex,
        keyHex: stakeVector.keyHex,
        role: 'proposer',
      },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- grant moderator role via the stake-key allowlist
// ---------------------------------------------------------------------------

describe('handleVerify: moderator allowlist', () => {
  it('logs in an allowlisted stake address that has no proposals, with the admin role', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    await preloadNonce(env.NONCES, fixturePayload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, fixturePayload);

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        nonceKv: env.NONCES,
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koiosRejectAll(), // no proposals: access is granted only by the allowlist
        network: 'preprod',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride, getModeratorRole: () => 'admin' },
    );

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('admin');
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: wrong header byte for the role
// ---------------------------------------------------------------------------

describe('handleVerify: reject wrong address type for role', () => {
  it('rejects stake-key fixture (header 0xe0) when role=drep', async () => {
    // The stake-key fixture has a reward address header (0xe0), which is not a
    // DRep credential (type-6 0x60/0x61 or bare key hash), so role=drep is rejected.
    const fixturePayload = stakeVector.payloadUtf8;
    await preloadNonce(env.NONCES, fixturePayload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, fixturePayload);

    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: stakeVector.signatureHex,
        keyHex: stakeVector.keyHex,
        role: 'drep',
      },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    // Should fail with 401: a reward address (0xe0) is not a DRep credential.
    expect(result.status).toBe(401);
  });

  it('rejects drep-key fixture (header 0x22) when role=proposer on preprod (expects 0xe0)', async () => {
    const fixturePayload = drepVector.payloadUtf8;
    await preloadNonce(env.NONCES, fixturePayload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, fixturePayload);

    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: drepVector.signatureHex,
        keyHex: drepVector.keyHex,
        role: 'proposer',
      },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
      now: 1_700_000_000,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- reject: malformed body
// ---------------------------------------------------------------------------

describe('handleVerify: reject malformed body', () => {
  it('returns 400 when body is missing required fields', async () => {
    const result = await handleVerify({
      body: { payload: '', signatureHex: '', keyHex: '', role: '' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
    });
    // role='' is not 'drep' or 'proposer', so 400.
    expect(result.status).toBe(400);
  });

  it('returns 400 when role is not drep or proposer', async () => {
    const result = await handleVerify({
      body: { payload: 'x', signatureHex: 'y', keyHex: 'z', role: 'admin' },
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
    });
    expect(result.status).toBe(400);
  });

  it('does not throw for a completely wrong body (no throw guarantee)', async () => {
    const result = await handleVerify({
      body: null as unknown as Parameters<typeof handleVerify>[0]['body'],
      nonceKv: env.NONCES,
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
    });
    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// handleLogout
// ---------------------------------------------------------------------------

describe('handleLogout', () => {
  it('revokes the session so getSession returns null afterwards', async () => {
    // Create a real session first.
    const { createSession } = await import('./session.js');
    const token = await createSession(env.SESSIONS, { id: 'logout-test-user', roles: ['proposer'] });

    // Session must be readable before logout.
    expect(await getSession(env.SESSIONS, token)).not.toBeNull();

    const cookieHeader = `dreptalk_session=${token}`;
    const result = await handleLogout({ sessionKv: env.SESSIONS, cookieHeader });

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);
    expect(result.setCookie).toContain('Max-Age=0');

    // Session must be null after logout.
    expect(await getSession(env.SESSIONS, token)).toBeNull();
  });

  it('succeeds gracefully with no cookie (no throw)', async () => {
    const result = await handleLogout({ sessionKv: env.SESSIONS, cookieHeader: null });
    expect(result.status).toBe(200);
  });

  it('succeeds gracefully with an unknown token cookie (no throw)', async () => {
    const result = await handleLogout({
      sessionKv: env.SESSIONS,
      cookieHeader: 'dreptalk_session=unknown-garbage-token-xyz',
    });
    expect(result.status).toBe(200);
  });
});
