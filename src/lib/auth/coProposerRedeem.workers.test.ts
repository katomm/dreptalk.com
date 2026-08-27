// Workers-runtime tests for co-proposer invite redemption -- runs in real
// workerd via @cloudflare/vitest-pool-workers. Uses the real D1/KV bindings
// and the shared CIP-8 reward-address fixture (stakeVector) that
// handlers.workers.test.ts and linkStake.workers.test.ts already sign against.
//
// Nonce alignment strategy (mirrors linkStake.workers.test.ts): the fixture
// signs a fixed payload that does not match the real
// "dreptalk:<domain>:<nonce>:<issuedAt>" format, so tests inject a
// consumeNonceForDomain override rather than seeding the D1 auth_nonces
// table. The override enforces both single-use AND the expected domain, so
// the "wrong domain" tests exercise the real security property: the domain
// handleRedeemGrant asks for is derived from the grantId resolved server-side
// from the invite code, never from anything the client claims directly.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import vectors from './__fixtures__/cip8-vectors.json';
import { handleRedeemChallenge, handleRedeemGrant, grantRedeemDomain, MAX_CO_PROPOSER_NAME } from './coProposerRedeem.js';
import { createGrantInvite, redeemGrant } from '../db/proposerGrants.js';
import { upsertUserFromAuth, getUserById } from '../db/users.js';
import { getSession } from './session.js';

const db = () => env.DB as D1Database;
const NOW = 1_700_000_000;

const stakeVector = vectors.vectors.find((v) => v.label === 'stake-key-valid')!;
const STAKE_ADDR = stakeVector.expectedStakeAddress;
const FIXTURE_PAYLOAD = stakeVector.payloadUtf8;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `${NOW}-${seq}`;
}

/** Creates a proposer account and a pending invite, defaulting to a stake address distinct from the fixture's. */
async function makeInvite(opts?: { proposerStakeAddr?: string; now?: number }) {
  const proposerStakeAddr = opts?.proposerStakeAddr ?? `stake_test1-proposer-${nextId()}`;
  const proposer = await upsertUserFromAuth(db(), { stakeAddr: proposerStakeAddr, roles: ['proposer'], now: NOW });
  const invite = await createGrantInvite(db(), {
    proposerUserId: proposer.id,
    proposerStakeAddr,
    now: opts?.now ?? NOW,
  });
  if (!invite) throw new Error('makeInvite: createGrantInvite returned null');
  return { proposerUserId: proposer.id, proposerStakeAddr, ...invite };
}

/** Single-use, domain-scoped nonce override; mirrors linkStake.workers.test.ts's helper. */
function makeDomainScopedNonceOverride(payload: string, issuedForDomain: string) {
  let used = false;
  return async (_db: D1Database, payloadArg: string, domainArg: string): Promise<boolean> => {
    if (domainArg !== issuedForDomain) return false;
    if (payloadArg !== payload) return false;
    if (used) return false;
    used = true;
    return true;
  };
}

/** A KV whose put() always throws, to simulate a session-mint failure after the grant already claimed. */
function throwingSessionKv(): KVNamespace {
  return {
    get: async () => null,
    put: async () => {
      throw new Error('kv unavailable');
    },
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

async function grantStatus(grantId: string): Promise<string | null> {
  const row = await db().prepare('SELECT status FROM proposer_grants WHERE id = ?1').bind(grantId).first<{ status: string }>();
  return row?.status ?? null;
}

describe('handleRedeemChallenge', () => {
  it('404s for an unknown code', async () => {
    const result = await handleRedeemChallenge({ db: db(), code: 'not-a-real-code', now: NOW });
    expect(result.status).toBe(404);
    expect((result.json as { ok: boolean }).ok).toBe(false);
  });

  it('404s for an expired invite', async () => {
    const invite = await makeInvite({ now: NOW });
    const result = await handleRedeemChallenge({ db: db(), code: invite.inviteCode, now: invite.expiresAt + 1 });
    expect(result.status).toBe(404);
  });

  it('404s for an already-redeemed invite', async () => {
    const invite = await makeInvite();
    const coStakeAddr = `stake_test1-co-${nextId()}`;
    const claim = await redeemGrant(db(), {
      grantId: invite.grantId,
      coUserId: coStakeAddr,
      coStakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(claim.ok).toBe(true);

    const result = await handleRedeemChallenge({ db: db(), code: invite.inviteCode, now: NOW });
    expect(result.status).toBe(404);
  });

  it('issues a payload bound to the grant_redeem domain for the resolved grant', async () => {
    const invite = await makeInvite();
    const result = await handleRedeemChallenge({ db: db(), code: invite.inviteCode, now: NOW });
    expect(result.status).toBe(200);
    const { payload } = result.json as { payload: string };
    expect(payload).toContain(grantRedeemDomain(invite.grantId));
    expect(payload).toMatch(new RegExp(`^dreptalk:${grantRedeemDomain(invite.grantId)}:[^:]+:\\d+$`));
  });
});

describe('handleRedeemGrant: happy path', () => {
  it('valid CIP-8 reward-address sig + fresh nonce redeems, mints a session with grantId/actsFor and proposer role', async () => {
    const invite = await makeInvite();
    const domain = grantRedeemDomain(invite.grantId);

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'preprod',
        now: NOW,
        secure: false,
        body: {
          code: invite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'Co-Proposer Carla',
        },
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, domain) },
    );

    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; user: { id: string; roles: string[] } };
    expect(json.ok).toBe(true);
    expect(json.user.roles).toContain('proposer');
    expect(result.setCookie).toBeTruthy();
    expect(result.setCookie).toContain('dreptalk_session=');

    const token = /dreptalk_session=([^;]+)/.exec(result.setCookie!)![1];
    // Same clock as the mint: the session carries an absolute lifetime cap, so
    // reading a NOW-stamped session at wall-clock time would read it as expired.
    const session = await getSession(env.SESSIONS, token, { now: NOW });
    expect(session).not.toBeNull();
    expect(session?.grantId).toBe(invite.grantId);
    expect(session?.actsFor).toEqual({ userId: invite.proposerUserId, stakeAddr: invite.proposerStakeAddr });
    expect(session?.roles).toContain('proposer');

    expect(await grantStatus(invite.grantId)).toBe('active');

    const coRow = await getUserById(db(), STAKE_ADDR);
    expect(coRow?.display_name).toBe('Co-Proposer Carla');
  });
});

describe('handleRedeemGrant: nonce domain scoping', () => {
  it('rejects a nonce issued for the LOGIN domain (not the grant_redeem domain) and does not burn it', async () => {
    const invite = await makeInvite();
    // Simulates a nonce that was actually issued under the plain login domain
    // (e.g. "dreptalk.com") rather than this grant's redeem domain.
    const override = makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, 'dreptalk.com');

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'preprod',
        now: NOW,
        body: {
          code: invite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'Carla',
        },
      },
      { consumeNonceForDomain: override },
    );

    expect(result.status).toBe(401);
    expect(await grantStatus(invite.grantId)).toBe('pending');
  });

  it('rejects a nonce issued for a DIFFERENT grant id', async () => {
    const inviteA = await makeInvite();
    const inviteB = await makeInvite();
    // The nonce override is scoped to grant B's domain, but the request
    // redeems grant A's code -- handleRedeemGrant must ask for grant A's domain.
    const override = makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, grantRedeemDomain(inviteB.grantId));

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'preprod',
        now: NOW,
        body: {
          code: inviteA.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'Carla',
        },
      },
      { consumeNonceForDomain: override },
    );

    expect(result.status).toBe(401);
    expect(await grantStatus(inviteA.grantId)).toBe('pending');
  });
});

describe('handleRedeemGrant: wrong network', () => {
  it('rejects a preprod-signed reward address when the site network is mainnet', async () => {
    const invite = await makeInvite();
    const domain = grantRedeemDomain(invite.grantId);

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'mainnet',
        now: NOW,
        body: {
          code: invite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'Carla',
        },
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, domain) },
    );

    expect(result.status).toBe(401);
    expect(await grantStatus(invite.grantId)).toBe('pending');
  });
});

describe('handleRedeemGrant: displayName bounds', () => {
  it('rejects a missing displayName 400 before any nonce consumption', async () => {
    const invite = await makeInvite();
    let called = false;
    const spyingOverride = async () => {
      called = true;
      return true;
    };

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'preprod',
        now: NOW,
        body: {
          code: invite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: '',
        },
      },
      { consumeNonceForDomain: spyingOverride },
    );

    expect(result.status).toBe(400);
    expect(called).toBe(false);
    expect(await grantStatus(invite.grantId)).toBe('pending');
  });

  it('rejects an overlong displayName 400 before any nonce consumption', async () => {
    const invite = await makeInvite();
    let called = false;
    const spyingOverride = async () => {
      called = true;
      return true;
    };

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'preprod',
        now: NOW,
        body: {
          code: invite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'x'.repeat(MAX_CO_PROPOSER_NAME + 1),
        },
      },
      { consumeNonceForDomain: spyingOverride },
    );

    expect(result.status).toBe(400);
    expect(called).toBe(false);
    expect(await grantStatus(invite.grantId)).toBe('pending');
  });
});

describe('handleRedeemGrant: existing account keeps its display name', () => {
  it('does not overwrite an existing display_name on the co-proposer row', async () => {
    // Pre-seed an account already owning the fixture's stake address, with a
    // display_name already set.
    await upsertUserFromAuth(db(), { stakeAddr: STAKE_ADDR, roles: [], now: NOW });
    await db().prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('Original Name', STAKE_ADDR).run();

    const invite = await makeInvite();
    const domain = grantRedeemDomain(invite.grantId);

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'preprod',
        now: NOW,
        body: {
          code: invite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'Attempted Override',
        },
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, domain) },
    );

    expect(result.status).toBe(200);
    const row = await getUserById(db(), STAKE_ADDR);
    expect(row?.display_name).toBe('Original Name');
  });
});

describe('handleRedeemGrant: stake key already holds a mandate', () => {
  it('returns 409 mandate_taken', async () => {
    // First grant is already active for the fixture's stake address.
    const firstInvite = await makeInvite();
    const firstClaim = await redeemGrant(db(), {
      grantId: firstInvite.grantId,
      coUserId: STAKE_ADDR,
      coStakeAddr: STAKE_ADDR,
      displayName: 'Carla',
      now: NOW,
    });
    expect(firstClaim.ok).toBe(true);

    // A second, unrelated grant attempts to redeem with the same wallet.
    const secondInvite = await makeInvite();
    const domain = grantRedeemDomain(secondInvite.grantId);

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'preprod',
        now: NOW,
        body: {
          code: secondInvite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'Carla',
        },
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, domain) },
    );

    expect(result.status).toBe(409);
    expect((result.json as { ok: boolean; error: string }).error).toBe('mandate_taken');
    expect(await grantStatus(secondInvite.grantId)).toBe('pending');
  });
});

describe('handleRedeemGrant: self-invite', () => {
  it("rejects redeeming with the proposer's own wallet: 400 cannot invite yourself", async () => {
    // The invite's proposer_stake_addr is the fixture's own derived stake
    // address, so redeeming with the same wallet is a self-invite.
    const invite = await makeInvite({ proposerStakeAddr: STAKE_ADDR });
    const domain = grantRedeemDomain(invite.grantId);

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: env.SESSIONS,
        network: 'preprod',
        now: NOW,
        body: {
          code: invite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'Carla',
        },
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, domain) },
    );

    expect(result.status).toBe(400);
    expect((result.json as { ok: boolean; error: string }).error).toBe('cannot invite yourself');
    expect(await grantStatus(invite.grantId)).toBe('pending');
  });
});

describe('handleRedeemGrant: session mint failure after redeem', () => {
  it('leaves the grant active so the login fallback can recover it later', async () => {
    const invite = await makeInvite();
    const domain = grantRedeemDomain(invite.grantId);

    const result = await handleRedeemGrant(
      {
        db: db(),
        sessionKv: throwingSessionKv(),
        network: 'preprod',
        now: NOW,
        body: {
          code: invite.inviteCode,
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          displayName: 'Carla',
        },
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, domain) },
    );

    expect(result.status).toBe(500);
    expect(await grantStatus(invite.grantId)).toBe('active');
  });
});
