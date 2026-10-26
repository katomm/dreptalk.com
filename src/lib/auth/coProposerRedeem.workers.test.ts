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
import { loadRedeemInvite, handleRedeemChallenge, handleRedeemGrant, grantRedeemDomain, MAX_CO_PROPOSER_NAME } from './coProposerRedeem.js';
import { createGrantInvite, redeemGrant } from '../db/proposerGrants.js';
import { upsertUserFromAuth, getUserById } from '../db/users.js';
import { getSession } from './session.js';
import { handleVerify } from './handlers.js';
import { handleLinkStake } from './linkStake.js';
import { makeCoseSignature, type6Address } from './__fixtures__/makeCose.js';

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
    govActionId: `${'a'.repeat(64)}#0`,
    teamLabel: null,
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
  it('valid CIP-8 reward-address sig + fresh nonce redeems, mints a co-proposer session without grant fields or the proposer role', async () => {
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
    expect(json.user.roles).toContain('co-proposer');
    expect(json.user.roles).not.toContain('proposer');
    expect(result.setCookie).toBeTruthy();
    expect(result.setCookie).toContain('dreptalk_session=');

    const token = /dreptalk_session=([^;]+)/.exec(result.setCookie!)![1];
    // Same clock as the mint: the session carries an absolute lifetime cap, so
    // reading a NOW-stamped session at wall-clock time would read it as expired.
    const session = await getSession(env.SESSIONS, token, { now: NOW });
    expect(session).not.toBeNull();
    expect(session).not.toHaveProperty('grantId');
    expect(session).not.toHaveProperty('actsFor');
    expect(session?.roles).toContain('co-proposer');
    expect(session?.roles).not.toContain('proposer');

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
    // The losing pending invite is deleted in the same call.
    expect(await grantStatus(secondInvite.grantId)).toBeNull();
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

// ---------------------------------------------------------------------------
// DRep with and without a linked stake address
// ---------------------------------------------------------------------------

const DREP_SEED = new Uint8Array(32).fill(33);

function drepKoios() {
  return {
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
  };
}

/** Logs in through the DRep door with a fresh single-use nonce and returns the session roles. */
async function drepDoorLogin(nonce: string): Promise<{ id: string; roles: string[] }> {
  const payload = `dreptalk:dreptalk.com:${nonce}:${NOW}`;
  const { keyHash } = makeCoseSignature({ seed: DREP_SEED, payload, addressBytes: new Uint8Array(28) });
  const cose = makeCoseSignature({ seed: DREP_SEED, payload, addressBytes: type6Address(keyHash, 'preprod') });
  let used = false;
  const result = await handleVerify(
    {
      body: { payload, signatureHex: cose.signatureHex, keyHex: cose.keyHex, role: 'drep' },
      sessionKv: env.SESSIONS,
      db: db(),
      koios: drepKoios(),
      network: 'preprod',
      now: NOW,
      secure: false,
    },
    {
      consumeNonce: async (_d: D1Database, p: string) => {
        if (p !== payload || used) return false;
        used = true;
        return true;
      },
    },
  );
  expect(result.status).toBe(200);
  return (result.json as { user: { id: string; roles: string[] } }).user;
}

async function redeemWithStakeKey(invite: { grantId: string; inviteCode: string }) {
  return handleRedeemGrant(
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
        displayName: 'Drep Dora',
      },
    },
    { consumeNonceForDomain: makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, grantRedeemDomain(invite.grantId)) },
  );
}

describe('DRep door and the co-proposer role', () => {
  it('a DRep who linked the stake address before redeeming gets drep and co-proposer on the DRep door', async () => {
    const drep = await drepDoorLogin('drep-linked-1');
    expect(drep.roles).toContain('drep');
    expect(drep.roles).not.toContain('co-proposer');

    const link = await handleLinkStake(
      {
        db: db(),
        userId: drep.id,
        body: { payload: FIXTURE_PAYLOAD, signatureHex: stakeVector.signatureHex, keyHex: stakeVector.keyHex },
        network: 'preprod',
        now: NOW,
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(FIXTURE_PAYLOAD, `link_stake:${drep.id}`) },
    );
    expect(link.status).toBe(200);

    const invite = await makeInvite();
    const redeemed = await redeemWithStakeKey(invite);
    expect(redeemed.status).toBe(200);
    // Redeem resolved the DRep's own account, so the grant belongs to it.
    expect((redeemed.json as { user: { id: string } }).user.id).toBe(drep.id);

    const again = await drepDoorLogin('drep-linked-2');
    expect(again.id).toBe(drep.id);
    expect(again.roles).toContain('drep');
    expect(again.roles).toContain('co-proposer');
  });

  it('a DRep who did not link gets a separate stake account: no co-proposer on the DRep door, co-proposer on the proposer door', async () => {
    const drep = await drepDoorLogin('drep-unlinked-1');

    const invite = await makeInvite();
    const redeemed = await redeemWithStakeKey(invite);
    expect(redeemed.status).toBe(200);
    const coId = (redeemed.json as { user: { id: string } }).user.id;
    expect(coId).not.toBe(drep.id);

    const again = await drepDoorLogin('drep-unlinked-2');
    expect(again.roles).toContain('drep');
    expect(again.roles).not.toContain('co-proposer');

    const proposerDoor = await handleVerify(
      {
        body: {
          payload: FIXTURE_PAYLOAD,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
          role: 'proposer',
        },
        sessionKv: env.SESSIONS,
        db: db(),
        koios: {
          drepInfo: async () => null,
          accountInfo: async () => null,
          proposalsByReturnAddress: async () => [],
        },
        network: 'preprod',
        now: NOW,
        secure: false,
      },
      {
        consumeNonce: async (_d: D1Database, p: string) => p === FIXTURE_PAYLOAD,
      },
    );
    expect(proposerDoor.status).toBe(200);
    const pj = proposerDoor.json as { user: { id: string; roles: string[] } };
    expect(pj.user.id).toBe(coId);
    expect(pj.user.roles).toContain('co-proposer');
    expect(pj.user.roles).not.toContain('proposer');
  });
});

describe('loadRedeemInvite', () => {
  async function seedAction(id: string, title: string | null, type = 'TreasuryWithdrawals') {
    await db()
      .prepare(
        `INSERT INTO governance_actions (id, type, title, status, return_address, topic_id, created_at, last_synced_at)
         VALUES (?1, ?2, ?3, 'active', 'x', 'topic-1', 1, 1)`,
      )
      .bind(id, type, title)
      .run();
  }

  async function inviteFor(govActionId: string, teamLabel: string | null) {
    const stakeAddr = `stake_test1-proposer-${nextId()}`;
    const proposer = await upsertUserFromAuth(db(), { stakeAddr, roles: ['proposer'], now: NOW });
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.id,
      proposerStakeAddr: stakeAddr,
      govActionId,
      teamLabel,
      now: NOW,
    });
    if (!invite) throw new Error('no invite');
    return { stakeAddr, ...invite };
  }

  it('returns the action title, id and team label for a valid code', async () => {
    const id = `${'1'.repeat(64)}#2`;
    await seedAction(id, 'Fund the thing');
    const invite = await inviteFor(id, 'Trivolve Tech');
    const view = await loadRedeemInvite(db(), invite.inviteCode, { now: NOW });
    expect(view).toEqual({
      proposerStakeAddr: invite.stakeAddr,
      govActionId: id,
      actionTitle: 'Fund the thing',
      teamLabel: 'Trivolve Tech',
    });
  });

  it('falls back to the action type plus a short id when there is no title', async () => {
    const id = `${'2'.repeat(64)}#0`;
    await seedAction(id, null);
    const invite = await inviteFor(id, null);
    const view = await loadRedeemInvite(db(), invite.inviteCode, { now: NOW });
    expect(view?.actionTitle).toBe('Treasury Withdrawals 222222\u202622222#0');
    expect(view?.teamLabel).toBeNull();
  });

  it('returns null for an unknown code', async () => {
    expect(await loadRedeemInvite(db(), 'nope', { now: NOW })).toBeNull();
  });
});
