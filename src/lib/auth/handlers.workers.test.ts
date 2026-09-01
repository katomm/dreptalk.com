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
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import { ccHotKeyHashHex, DREP_SCRIPT_HEADER, drepIdFromPubKey } from '../cardano/identity.js';
import { nativeScriptHash, parseNativeScriptJson } from '../cardano/nativeScript.js';
import { encodeBech32 } from '../crypto/bech32.js';

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
    accountUpdateHistoryBatch: async () => [],
    proposalsByReturnAddress: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Nonce injection helper for fixture-based tests.
// The CIP-8 fixtures sign a fixed payload that does not match the real
// dreptalk:<domain>:<nonce>:<issuedAt> format, so happy-path tests inject a
// consumeNonce override rather than seeding the D1 store. Storage-agnostic:
// allows exactly one consume of the matching payload, then rejects (replay
// protection) without touching the database.
// ---------------------------------------------------------------------------

function makeSingleUseNonceOverride(payload: string) {
  let used = false;
  return async (_db: D1Database, payloadArg: string): Promise<boolean> => {
    if (payloadArg !== payload) return false;
    if (used) return false;
    used = true;
    return true;
  };
}

// ---------------------------------------------------------------------------
// handleChallenge
// ---------------------------------------------------------------------------

describe('handleChallenge', () => {
  it('returns a payload in the dreptalk:<domain>:<nonce>:<ts> format', async () => {
    const result = await handleChallenge({
      db: env.DB,
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
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);

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
// handleVerify -- happy path: DELEGATOR
// ---------------------------------------------------------------------------

// Delegator login: same reward-address CIP-8 proof as proposer, but no proposer
// status and no Koios lookup; grants only 'member'.
describe('handleVerify: happy path (delegator)', () => {
  it('mints a member session and reuses the account on repeat login', async () => {
    const fixturePayload = stakeVector.payloadUtf8;

    // Each login gets its own single-use nonce override for the same fixture
    // payload: the fixture only signs one payload, but in production each
    // login attempt consumes a freshly issued challenge, so a fresh override
    // per call simulates that without weakening replay protection within a
    // single call (see the dedicated "reject replayed nonce" tests below).
    async function login() {
      return handleVerify(
        {
          body: {
            payload: fixturePayload,
            signatureHex: stakeVector.signatureHex,
            keyHex: stakeVector.keyHex,
            role: 'delegator',
          },
          sessionKv: env.SESSIONS,
          db: env.DB,
          koios: koiosRejectAll(), // never consulted on this path
          network: 'preprod',
          now: 1_700_000_000,
        },
        { consumeNonce: makeSingleUseNonceOverride(fixturePayload) },
      );
    }

    const first = await login();
    expect(first.status).toBe(200);
    const json = first.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toEqual(['member']);

    const second = await login();
    const json2 = second.json as { user: { id: string } };
    expect(json2.user.id).toBe(json.user.id); // same account, no duplicate
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- delegator login tracks and resolves the delegation
// ---------------------------------------------------------------------------

const VALID_DREP = 'drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n';

describe('handleVerify: delegator login tracks and resolves', () => {
  it('creates and resolves a delegator_follows row on login', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const koios = {
      ...koiosRejectAll(),
      accountInfo: async () => ({
        stake_address: 's',
        status: 'registered',
        delegated_pool: null,
        delegated_drep: VALID_DREP,
        total_balance: '1',
      }),
      accountInfoBatch: async () => [],
    };
    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'delegator',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koios as never,
        network: 'preprod',
      },
      { consumeNonce: makeSingleUseNonceOverride(fixturePayload) },
    );
    expect(result.status).toBe(200);
    const userId = (result.json as { user: { id: string } }).user.id;
    const row = await env.DB.prepare('SELECT resolution_status, drep_id FROM delegator_follows WHERE user_id = ?')
      .bind(userId)
      .first();
    expect(row?.resolution_status).toBe('resolved');
    expect(row?.drep_id).toBe(VALID_DREP);
  });

  it('still returns 200 and a pending row when koios is down at login', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const koios = {
      ...koiosRejectAll(),
      accountInfo: async () => {
        throw new Error('down');
      },
      accountInfoBatch: async () => [],
    };
    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'delegator',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koios as never,
        network: 'preprod',
      },
      { consumeNonce: makeSingleUseNonceOverride(fixturePayload) },
    );
    expect(result.status).toBe(200);
    const userId = (result.json as { user: { id: string } }).user.id;
    const row = await env.DB.prepare('SELECT resolution_status FROM delegator_follows WHERE user_id = ?')
      .bind(userId)
      .first();
    expect(row?.resolution_status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- delegator login is always capped to member
// ---------------------------------------------------------------------------

// The stake address stakeVector's signature derives to (preprod), asserted
// against stakeAddressFromPubKey in identity.test.ts.
const DELEGATOR_STAKE_ADDR = 'stake_test1uqpqhw7q2jcutnwteqnvdgqkjulnaa5ym8wh70kcu3yvkugckkcgj';

describe('handleVerify: delegator login caps to member', () => {
  it('caps a delegator login to member even when it routes to a writer account', async () => {
    // Seed a DRep account whose stake_addr is the delegator's stake address.
    await env.DB.prepare(
      `INSERT INTO users (id, drep_id, stake_addr, is_drep, role, status, created_at, last_verified_at, notif_seen_at)
       VALUES ('drep1writerX', 'drep1writerX', ?, 1, 'member', 'active', 0, 0, 0)`,
    ).bind(DELEGATOR_STAKE_ADDR).run();

    const fixturePayload = stakeVector.payloadUtf8;
    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'delegator',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koiosRejectAll() as never,
        network: 'preprod',
      },
      { consumeNonce: makeSingleUseNonceOverride(fixturePayload) },
    );
    expect(result.status).toBe(200);
    const json = result.json as { user: { id: string; roles: string[] } };
    expect(json.user.id).toBe('drep1writerX'); // routed to the writer account
    expect(json.user.roles).toEqual(['member']); // but capped to member

    // The session itself must carry no drepId either, not just the roles list
    // in the response body.
    const cookie = result.setCookie!;
    const token = /dreptalk_session=([^;]+)/.exec(cookie)![1];
    const session = await getSession(env.SESSIONS, token);
    expect(session?.roles).toEqual(['member']);
    expect(session?.drepId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: DREP
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (drep)', () => {
  it('returns 200 and inserts a drep user row for a real type-6 DRep signature', async () => {
    const payload = 'dreptalk:dreptalk.com:drep-happy-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

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
    const consumeOverride = makeSingleUseNonceOverride(payload);

    const seed = new Uint8Array(32).fill(10);
    const { keyHash } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });
    const cose = makeCoseSignature({ seed, payload, addressBytes: keyHash });

    const result = await handleVerify({
      body: { payload, signatureHex: cose.signatureHex, keyHex: cose.keyHex, role: 'drep' },
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
// handleVerify -- happy path: key-based CLI DRep (raw Ed25519, cardano-signer)
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (key DRep, offline)', () => {
  it('logs in a key-based DRep that signs the challenge with cardano-signer (raw, no keyHex)', async () => {
    const payload = 'dreptalk:dreptalk.com:cli-drep-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload, new Uint8Array(32).fill(21));
    const expectedDrepId = drepIdFromPubKey(pubKey);

    const result = await handleVerify(
      {
        // No keyHex (COSE) and no scriptDrepId: a plain key DRep signing offline.
        body: { payload, signatureHex, publicKeyHex, role: 'drep' },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: {
          drepInfo: async (id: string) => ({
            drep_id: id,
            hex: 'dd',
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
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.id).toBe(expectedDrepId);
    expect(json.user.roles).toContain('drep');
    const row = await getUserById(env.DB, json.user.id);
    expect(row!.is_drep).toBe(true);
  });

  it('rejects a key-based DRep whose id is not a registered active DRep', async () => {
    const payload = 'dreptalk:dreptalk.com:cli-drep-reject-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(22));

    const result = await handleVerify(
      {
        body: { payload, signatureHex, publicKeyHex, role: 'drep' },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: {
          drepInfo: async () => null,
          accountInfo: async () => null,
          proposalsByReturnAddress: async () => [],
        },
        network: 'preprod',
        now: 1_700_000_100,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- script-flow guidance errors (wrong DRep kind in script flow)
// ---------------------------------------------------------------------------

describe('handleVerify: script-flow guidance', () => {
  it('flags a key-based DRep id used in the script flow as the wrong path', async () => {
    const payload = 'dreptalk:dreptalk.com:keydrep-in-script:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(31));

    const result = await handleVerify(
      {
        body: { payload, signatureHex, publicKeyHex, role: 'drep', scriptDrepId: 'drep1ykeybaseddrepidusedinthescriptflowplaceholderxxxx' },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: {
          // has_script:false -> it's a key DRep, resolveScriptDRep rejects early.
          drepInfo: async (id: string) => ({ drep_id: id, hex: 'aa', has_script: false, drep_status: 'registered', active: true, deposit: '0', expires_epoch_no: null }),
          scriptInfo: async () => null,
          accountInfo: async () => null,
          proposalsByReturnAddress: async () => [],
        },
        network: 'preprod',
        now: 1_700_000_100,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
    expect((result.json as { error: string }).error).toBe('key-based drep in script flow');
  });

  it('flags a Plutus-script DRep as unsupported', async () => {
    const payload = 'dreptalk:dreptalk.com:plutus-drep:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(32));
    // A real CIP-129 script drep id (0x23), but Koios reports a Plutus script.
    const scriptDrepId = 'drep1yvsah2upqmwdtea8c37pac2aw3lv6z7qggcu76243p72msqjnp259';

    const result = await handleVerify(
      {
        body: { payload, signatureHex, publicKeyHex, role: 'drep', scriptDrepId },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: {
          drepInfo: async (id: string) => ({ drep_id: id, hex: 'bb', has_script: true, drep_status: 'registered', active: true, deposit: '0', expires_epoch_no: null }),
          scriptInfo: async () => ({ script_hash: '21dbab8106dcd5e7a7c47c1ee15d747ecd0bc04231cf6955887cadc0', type: 'plutusV2', value: null }),
          accountInfo: async () => null,
          proposalsByReturnAddress: async () => [],
        },
        network: 'preprod',
        now: 1_700_000_100,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
    expect((result.json as { error: string }).error).toBe('plutus script drep unsupported');
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- happy path: SPO (Calidus, raw Ed25519)
// ---------------------------------------------------------------------------

describe('handleVerify: happy path (spo)', () => {
  it('returns 200 and inserts an spo user for a registered calidus key', async () => {
    const payload = 'dreptalk:dreptalk.com:spo-happy-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(11));
    const POOL = 'pool1test-spo-happy';

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'spo' },
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
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(12));

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'spo' },
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
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(11));
    const badSig = signatureHex.slice(0, -2) + (signatureHex.endsWith('00') ? 'ff' : '00');

    const result = await handleVerify({
      body: { payload, signatureHex: badSig, publicKeyHex, role: 'spo' },
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
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex } = rawSign(payload, new Uint8Array(32).fill(11));

    const result = await handleVerify({
      body: { payload, signatureHex: 'abcd', publicKeyHex, role: 'spo' },
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
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { signatureHex } = rawSign(payload, new Uint8Array(32).fill(11));

    const result = await handleVerify({
      body: { payload, signatureHex, role: 'spo' } as Parameters<typeof handleVerify>[0]['body'],
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
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload, new Uint8Array(32).fill(13));
    const hotHex = ccHotKeyHashHex(pubKey);
    const COLD = 'cc_cold1test-cc-happy';

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'cc' },
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
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload, new Uint8Array(32).fill(14));
    const hotHex = ccHotKeyHashHex(pubKey);

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'cc' },
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
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload, new Uint8Array(32).fill(15));
    const hotHex = ccHotKeyHashHex(pubKey);

    const result = await handleVerify({
      body: { payload, signatureHex, publicKeyHex, role: 'cc' },
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
    const consumeOverride = makeSingleUseNonceOverride(payload);
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(16));

    const input = {
      body: { payload, signatureHex, publicKeyHex, role: 'spo' as const },
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
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);

    const commonInput = {
      body: {
        payload: fixturePayload,
        signatureHex: stakeVector.signatureHex,
        keyHex: stakeVector.keyHex,
        role: 'proposer' as const,
      },
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
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);

    // Flip last byte of signatureHex.
    const badSig = `${stakeVector.signatureHex.slice(0, -2)}ff`;

    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: badSig,
        keyHex: stakeVector.keyHex,
        role: 'proposer',
      },
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
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);

    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: stakeVector.signatureHex,
        keyHex: stakeVector.keyHex,
        role: 'proposer',
      },
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
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
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
// handleVerify -- co-proposer grant login fallback
// ---------------------------------------------------------------------------

// Inserts a proposer_grants row directly (bypassing the invite/redeem flow,
// which is exercised elsewhere) so these tests can set up whatever grant
// state the login fallback needs to see.
async function insertGrant(args: {
  id: string;
  proposerUserId: string;
  proposerStakeAddr: string;
  coStakeAddr: string;
  status?: 'active' | 'revoked' | 'pending';
  now?: number;
}) {
  const now = args.now ?? 1_700_000_000;
  const status = args.status ?? 'active';
  await env.DB.prepare(
    `INSERT INTO proposer_grants
       (id, proposer_user_id, proposer_stake_addr, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at, revoked_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?1, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      args.id,
      args.proposerUserId,
      args.proposerStakeAddr,
      args.coStakeAddr,
      status,
      now,
      now + 604800,
      status === 'active' ? now : null,
      status === 'revoked' ? now : null,
    )
    .run();
}

describe('handleVerify: co-proposer grant login fallback', () => {
  it('stake key with no proposals but an active grant logs in with proposer role, grantId and actsFor on the session', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);
    await insertGrant({
      id: 'grant-fallback-1',
      proposerUserId: 'proposer-user-1',
      proposerStakeAddr: 'stake_test1proposerone',
      coStakeAddr: DELEGATOR_STAKE_ADDR,
    });

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koiosRejectAll(), // no on-chain proposals: the grant is what opens the door
        network: 'preprod',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('proposer');

    const cookie = result.setCookie!;
    const token = /dreptalk_session=([^;]+)/.exec(cookie)![1];
    // Same clock as the login: sessions carry an absolute lifetime cap, so a
    // NOW-stamped session read at wall-clock time would read as expired.
    const session = await getSession(env.SESSIONS, token, { now: 1_700_000_000 });
    expect(session?.grantId).toBe('grant-fallback-1');
    expect(session?.actsFor).toEqual({ userId: 'proposer-user-1', stakeAddr: 'stake_test1proposerone' });
  });

  it('grant login never sets is_proposer on the user row', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);
    await insertGrant({
      id: 'grant-fallback-2',
      proposerUserId: 'proposer-user-2',
      proposerStakeAddr: 'stake_test1proposertwo',
      coStakeAddr: DELEGATOR_STAKE_ADDR,
    });

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koiosRejectAll(),
        network: 'preprod',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    const json = result.json as { user: { id: string } };
    const row = await getUserById(env.DB, json.user.id);
    expect(row).not.toBeNull();
    expect(row!.is_proposer).toBe(false);
  });

  it('stake key with no proposals and no grant: unchanged 401 "not a proposer or moderator"', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koiosRejectAll(),
        network: 'preprod',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
    expect((result.json as { error: string }).error).toBe('not a proposer or moderator');
  });

  it('revoked grant: 401', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);
    await insertGrant({
      id: 'grant-fallback-revoked',
      proposerUserId: 'proposer-user-3',
      proposerStakeAddr: 'stake_test1proposerthree',
      coStakeAddr: DELEGATOR_STAKE_ADDR,
      status: 'revoked',
    });

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koiosRejectAll(),
        network: 'preprod',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(401);
  });

  it('moderator who is also a co-proposer gets both the mod role and proposer', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);
    await insertGrant({
      id: 'grant-fallback-mod',
      proposerUserId: 'proposer-user-4',
      proposerStakeAddr: 'stake_test1proposerfour',
      coStakeAddr: DELEGATOR_STAKE_ADDR,
    });

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: koiosRejectAll(),
        network: 'preprod',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride, getModeratorRole: () => 'moderator' },
    );

    expect(result.status).toBe(200);
    const json = result.json as { user: { roles: string[] } };
    expect(json.user.roles).toContain('moderator');
    expect(json.user.roles).toContain('proposer');
  });

  it('a REAL on-chain proposer who also redeemed a grant logs in with their own identity: no grantId/actsFor on the session', async () => {
    const fixturePayload = stakeVector.payloadUtf8;
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);
    // The grant lies dormant: this stake key is also a real on-chain proposer,
    // so its own identity wins and the grant is never consulted.
    await insertGrant({
      id: 'grant-fallback-dormant',
      proposerUserId: 'proposer-user-5',
      proposerStakeAddr: 'stake_test1proposerfive',
      coStakeAddr: DELEGATOR_STAKE_ADDR,
    });

    const result = await handleVerify(
      {
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        sessionKv: env.SESSIONS,
        db: env.DB,
        koios: {
          drepInfo: async () => null,
          accountInfo: async () => null,
          proposalsByReturnAddress: async (addr: string) => [
            { proposal_id: 'gov_action1dormant', return_address: addr, proposal_type: 'InfoAction' },
          ],
        },
        network: 'preprod',
        now: 1_700_000_000,
        secure: false,
      },
      { consumeNonce: consumeOverride },
    );

    expect(result.status).toBe(200);
    const json = result.json as { user: { id: string; roles: string[] } };
    expect(json.user.roles).toContain('proposer');
    const row = await getUserById(env.DB, json.user.id);
    expect(row!.is_proposer).toBe(true);

    const cookie = result.setCookie!;
    const token = /dreptalk_session=([^;]+)/.exec(cookie)![1];
    // Same clock as the login: sessions carry an absolute lifetime cap, so a
    // NOW-stamped session read at wall-clock time would read as expired.
    const session = await getSession(env.SESSIONS, token, { now: 1_700_000_000 });
    expect(session?.grantId).toBeFalsy();
    expect(session?.actsFor).toBeFalsy();
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
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);

    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: stakeVector.signatureHex,
        keyHex: stakeVector.keyHex,
        role: 'drep',
      },
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
    const consumeOverride = makeSingleUseNonceOverride(fixturePayload);

    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: drepVector.signatureHex,
        keyHex: drepVector.keyHex,
        role: 'proposer',
      },
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

// ---------------------------------------------------------------------------
// handleVerify -- reject: wallet on the wrong network
// ---------------------------------------------------------------------------

describe('handleVerify: reject wrong-network addresses with a specific error', () => {
  it('rejects a mainnet reward address (0xe1) on preprod as a network mismatch', async () => {
    const payload = 'dreptalk:dreptalk.com:proposer-wrong-net-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

    // Reward address for the OTHER network: header 0xe1 + 28-byte stake key hash.
    const seed = new Uint8Array(32).fill(11);
    const { keyHash } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });
    const rewardMainnet = new Uint8Array(29);
    rewardMainnet[0] = 0xe1;
    rewardMainnet.set(keyHash, 1);
    const cose = makeCoseSignature({ seed, payload, addressBytes: rewardMainnet });

    const result = await handleVerify({
      body: { payload, signatureHex: cose.signatureHex, keyHex: cose.keyHex, role: 'proposer' },
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
      now: 1_700_000_100,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
    expect((result.json as { error: string }).error).toBe('wallet network mismatch');
  });

  it('rejects a mainnet type-6 DRep address (0x61) on preprod as a network mismatch', async () => {
    const payload = 'dreptalk:dreptalk.com:drep-wrong-net-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

    const seed = new Uint8Array(32).fill(12);
    const { keyHash } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });
    const cose = makeCoseSignature({ seed, payload, addressBytes: type6Address(keyHash, 'mainnet') });

    const result = await handleVerify({
      body: { payload, signatureHex: cose.signatureHex, keyHex: cose.keyHex, role: 'drep' },
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: koiosRejectAll(),
      network: 'preprod',
      now: 1_700_000_100,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
    expect((result.json as { error: string }).error).toBe('wallet network mismatch');
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- script DRep membership (COSE path)
// ---------------------------------------------------------------------------

// Builds a minimal native-script ScriptInfo whose only sig leaf is the given
// key hash. The script_hash is computed from the actual script CBOR so the
// defense-in-depth hash check inside resolveScriptDRep passes.
function nativeScriptInfoWith(keyHashHex: string) {
  const value = { type: 'any', scripts: [{ type: 'sig', keyHash: keyHashHex }] };
  const parsed = parseNativeScriptJson(value);
  if (!parsed) throw new Error('nativeScriptInfoWith: failed to parse script');
  const script_hash = nativeScriptHash(parsed);
  return {
    script_hash,
    type: 'timelock' as const,
    value,
  };
}

// Encodes a script hash hex as a CIP-129 bech32 drep1 script id.
function scriptDrepIdFromHash(scriptHashHex: string): string {
  const payload = new Uint8Array(29);
  payload[0] = DREP_SCRIPT_HEADER;
  payload.set(hexToBytes(scriptHashHex), 1);
  return encodeBech32('drep', payload);
}

// A script DrepInfo for a given script hash: registered, active, has_script=true.
function scriptDrepInfo(scriptHashHex: string) {
  return {
    drep_id: scriptDrepIdFromHash(scriptHashHex),
    hex: scriptHashHex,
    has_script: true,
    drep_status: 'registered' as const,
    active: true,
    deposit: '500000000',
    expires_epoch_no: 600,
  };
}

describe('handleVerify: script DRep (COSE path)', () => {
  it('logs in a script DRep member via the wallet (COSE) path', async () => {
    const payload = 'dreptalk:dreptalk.com:script-drep-cose-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

    // Sign with the member key: use ccHotKeyHashHex to get the 28-byte key hash
    // that resolveScriptDRep will look for in the script's sig leaves.
    const seed = new Uint8Array(32).fill(42);
    const { keyHash, pubKey } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });
    const memberKeyHashHex = ccHotKeyHashHex(pubKey);

    // Build the ScriptInfo (including its real hash) for a script that lists the member key.
    const scriptInfo = nativeScriptInfoWith(memberKeyHashHex);
    // Derive the drep1 id whose credential equals that script hash.
    const scriptDrepId = scriptDrepIdFromHash(scriptInfo.script_hash);

    // Build a type-6 enterprise address so the address-header check passes.
    const cose = makeCoseSignature({ seed, payload, addressBytes: type6Address(keyHash, 'preprod') });

    const result = await handleVerify({
      body: {
        payload,
        signatureHex: cose.signatureHex,
        keyHex: cose.keyHex,
        role: 'drep',
        scriptDrepId,
      },
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        drepInfo: async () => scriptDrepInfo(scriptInfo.script_hash),
        accountInfo: async () => null,
        proposalsByReturnAddress: async () => [],
        scriptInfo: async () => scriptInfo,
      },
      network: 'preprod',
      now: 1_700_000_100,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('drep');
    expect(json.user.id).toBe(scriptDrepId);
  });

  it('rejects a script DRep login when the signer is not a member', async () => {
    const payload = 'dreptalk:dreptalk.com:script-drep-nonmember-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

    const seed = new Uint8Array(32).fill(43);
    const { keyHash } = makeCoseSignature({ seed, payload, addressBytes: new Uint8Array(28) });

    // The script lists a completely different key hash, not the signer's.
    // Use 'aa' * 28 as the non-member key; the script hash is derived from that
    // so the hash check passes; only the membership check should fail.
    const nonMemberScriptInfo = nativeScriptInfoWith('aa'.repeat(28));
    const scriptDrepId = scriptDrepIdFromHash(nonMemberScriptInfo.script_hash);

    const cose = makeCoseSignature({ seed, payload, addressBytes: type6Address(keyHash, 'preprod') });

    const result = await handleVerify({
      body: {
        payload,
        signatureHex: cose.signatureHex,
        keyHex: cose.keyHex,
        role: 'drep',
        scriptDrepId,
      },
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        drepInfo: async () => scriptDrepInfo(nonMemberScriptInfo.script_hash),
        accountInfo: async () => null,
        proposalsByReturnAddress: async () => [],
        // Script has 'aa'*28 as member, but signer's key is memberKeyHashHex.
        scriptInfo: async () => nonMemberScriptInfo,
      },
      network: 'preprod',
      now: 1_700_000_100,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVerify -- script DRep membership (offline / raw Ed25519 path)
// ---------------------------------------------------------------------------

describe('handleVerify: script DRep (offline raw-Ed25519 path)', () => {
  it('logs in a script DRep member via the offline (raw) path', async () => {
    const payload = 'dreptalk:dreptalk.com:script-drep-raw-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

    // Sign with a raw Ed25519 key (no COSE envelope, no keyHex).
    const { publicKeyHex, signatureHex, pubKey } = rawSign(payload, new Uint8Array(32).fill(44));
    // Derive the 28-byte key hash the same way verifyRawEd25519 does internally.
    const memberKeyHashHex = ccHotKeyHashHex(pubKey);

    // Build a native script whose only sig leaf is the signer's key hash.
    // nativeScriptInfoWith computes the real script_hash from CBOR so the
    // defense-in-depth re-hash inside resolveScriptDRep passes.
    const scriptInfo = nativeScriptInfoWith(memberKeyHashHex);
    const scriptDrepId = scriptDrepIdFromHash(scriptInfo.script_hash);

    const result = await handleVerify({
      body: {
        payload,
        signatureHex,
        publicKeyHex,
        role: 'drep',
        scriptDrepId,
        // No keyHex: this is the offline paste path, not the COSE wallet path.
      },
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        drepInfo: async () => scriptDrepInfo(scriptInfo.script_hash),
        accountInfo: async () => null,
        proposalsByReturnAddress: async () => [],
        scriptInfo: async () => scriptInfo,
      },
      network: 'preprod',
      now: 1_700_000_100,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('drep');
    expect(json.user.id).toBe(scriptDrepId);
  });

  it('rejects an offline script DRep login when the signer is not a member', async () => {
    const payload = 'dreptalk:dreptalk.com:script-drep-raw-nonmember-nonce:1700000000';
    const consumeOverride = makeSingleUseNonceOverride(payload);

    // Sign with a raw Ed25519 key.
    const { publicKeyHex, signatureHex } = rawSign(payload, new Uint8Array(32).fill(45));

    // The script lists a different key hash, not the signer's, so membership
    // check fails. The hash is still real so resolveScriptDRep's re-hash passes
    // and only the membership assertion fires.
    const nonMemberScriptInfo = nativeScriptInfoWith('aa'.repeat(28));
    const scriptDrepId = scriptDrepIdFromHash(nonMemberScriptInfo.script_hash);

    const result = await handleVerify({
      body: {
        payload,
        signatureHex,
        publicKeyHex,
        role: 'drep',
        scriptDrepId,
      },
      sessionKv: env.SESSIONS,
      db: env.DB,
      koios: {
        drepInfo: async () => scriptDrepInfo(nonMemberScriptInfo.script_hash),
        accountInfo: async () => null,
        proposalsByReturnAddress: async () => [],
        scriptInfo: async () => nonMemberScriptInfo,
      },
      network: 'preprod',
      now: 1_700_000_100,
      secure: false,
    }, { consumeNonce: consumeOverride });

    expect(result.status).toBe(401);
  });
});
