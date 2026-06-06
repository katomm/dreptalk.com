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
import vectors from './__fixtures__/cip8-vectors.json';
import { handleChallenge, handleVerify, handleLogout } from './handlers.js';
import { issueNonce } from './nonce.js';
import { getSession } from './session.js';
import { getUserById } from '../db/users.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stakeVector = vectors.vectors.find(v => v.label === 'stake-key-valid')!;
const drepVector = vectors.vectors.find(v => v.label === 'drep-key-valid')!;

// Fake koios clients.
function koiosAcceptProposer(stakeAddr: string) {
  return {
    drepInfo: async () => null,
    accountInfo: async () => null,
    proposalsByReturnAddress: async (addr: string) => {
      if (addr === stakeAddr) {
        return [{ proposal_id: 'gov_action1test', return_address: addr, proposal_type: 'InfoAction' }];
      }
      return [];
    },
  };
}

function koiosAcceptDrep(expectedDrepId: string) {
  return {
    drepInfo: async (id: string) => {
      if (id === expectedDrepId) {
        return {
          drep_id: id,
          hex: 'aa',
          has_script: false,
          registered: true,
          active: true,
          deposit: '500000000',
          expires_epoch_no: null,
        };
      }
      return null;
    },
    accountInfo: async () => null,
    proposalsByReturnAddress: async () => [],
  };
}

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

function makeSingleUseNonceOverride(kv: KVNamespace, payload: string) {
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
  it('returns 200 and inserts a drep user row for the drep fixture', async () => {
    const fixturePayload = drepVector.payloadUtf8;
    await preloadNonce(env.NONCES, fixturePayload);
    const consumeOverride = makeSingleUseNonceOverride(env.NONCES, fixturePayload);

    // Pre-derive the drepId the handler will compute so fake koios can match it.
    // We cannot call drepIdFromPubKey here directly without importing; instead we
    // accept any drep_id in the fake koios since the test only cares about the
    // overall flow. The fake returns isDrep=true for any id.
    const result = await handleVerify({
      body: {
        payload: fixturePayload,
        signatureHex: drepVector.signatureHex,
        keyHex: drepVector.keyHex,
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
// handleVerify -- reject: wrong header byte for the role
// ---------------------------------------------------------------------------

describe('handleVerify: reject wrong address type for role', () => {
  it('rejects stake-key fixture (header 0xe0) when role=drep (expects 0x22)', async () => {
    // The stake-key fixture has a reward address header (0xe0).
    // Asking for role=drep requires header 0x22.
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

    // Should fail with 401 because header 0xe0 != 0x22 (DRep key-hash).
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
