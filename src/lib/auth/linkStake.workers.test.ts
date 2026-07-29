// Workers-runtime tests for handleLinkStake -- runs in real workerd via
// @cloudflare/vitest-pool-workers. Uses the real D1 binding and the shared
// CIP-8 reward-address fixture (stakeVector) that handlers.workers.test.ts
// and walletLogin.test.ts already sign against.
//
// Nonce alignment strategy (mirrors handlers.workers.test.ts): the fixture
// signs a fixed payload that does not match the real
// "dreptalk:<domain>:<nonce>:<issuedAt>" format, so tests inject a
// consumeNonceForDomain override rather than seeding the D1 auth_nonces
// table. The override enforces both single-use AND the expected domain, so
// the "wrong nonce domain" test exercises the real security property: the
// domain handleLinkStake asks for is derived from the caller-supplied
// `userId` (which the route always sources from the authenticated session,
// never the request body), not from anything the client can pick directly.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import vectors from './__fixtures__/cip8-vectors.json';
import { handleLinkStake } from './linkStake.js';
import { getUserById } from '../db/users.js';

const stakeVector = vectors.vectors.find((v) => v.label === 'stake-key-valid')!;
const STAKE_ADDR = stakeVector.expectedStakeAddress;

// Single-use, domain-scoped nonce override. Returns false (without
// "consuming" anything) when the requested domain doesn't match the domain
// the fixture payload was notionally issued for -- exactly what the real
// consumeNonceForDomain does when a payload's embedded domain doesn't match
// the caller's expectation.
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

async function insertUser(id: string, stakeAddr: string | null, roles: { is_drep?: 1 | 0 } = {}) {
  await env.DB.prepare(
    `INSERT INTO users (id, stake_addr, is_drep, role, status, created_at, last_verified_at)
     VALUES (?, ?, ?, 'member', 'active', 0, 0)`,
  )
    .bind(id, stakeAddr, roles.is_drep ?? 0)
    .run();
}

describe('handleLinkStake: happy path', () => {
  it('links a free stake address to the account (200, users.stake_addr set)', async () => {
    const userId = 'writer-happy-1';
    await insertUser(userId, null);

    const fixturePayload = stakeVector.payloadUtf8;
    const domain = `link_stake:${userId}`;

    const result = await handleLinkStake(
      {
        db: env.DB,
        userId,
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
        },
        network: 'preprod',
        now: 1_700_000_000,
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(fixturePayload, domain) },
    );

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);

    const row = await getUserById(env.DB, userId);
    expect(row?.stake_addr).toBe(STAKE_ADDR);
  });
});

describe('handleLinkStake: idempotent re-link', () => {
  it('returns 200 when the same account links the same stake addr again', async () => {
    const userId = 'writer-idempotent-1';
    await insertUser(userId, STAKE_ADDR);

    const fixturePayload = stakeVector.payloadUtf8;
    const domain = `link_stake:${userId}`;

    const result = await handleLinkStake(
      {
        db: env.DB,
        userId,
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
        },
        network: 'preprod',
        now: 1_700_000_000,
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(fixturePayload, domain) },
    );

    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(true);

    const row = await getUserById(env.DB, userId);
    expect(row?.stake_addr).toBe(STAKE_ADDR);
  });
});

describe('handleLinkStake: account already has a different stake addr', () => {
  it('returns 409 without overwriting the existing stake_addr', async () => {
    const userId = 'writer-different-1';
    const otherAddr = 'stake_test1uqdifferentaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    await insertUser(userId, otherAddr);

    const fixturePayload = stakeVector.payloadUtf8;
    const domain = `link_stake:${userId}`;

    const result = await handleLinkStake(
      {
        db: env.DB,
        userId,
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
        },
        network: 'preprod',
        now: 1_700_000_000,
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(fixturePayload, domain) },
    );

    expect(result.status).toBe(409);
    expect((result.json as { ok: boolean; error: string }).ok).toBe(false);
    expect((result.json as { error: string }).error).toBe('account already has a stake wallet');

    const row = await getUserById(env.DB, userId);
    expect(row?.stake_addr).toBe(otherAddr); // untouched
  });
});

describe('handleLinkStake: stake addr owned by another account', () => {
  it('returns 409 collision without touching either account', async () => {
    const ownerId = 'writer-owner-1';
    const claimantId = 'writer-claimant-1';
    await insertUser(ownerId, STAKE_ADDR);
    await insertUser(claimantId, null);

    const fixturePayload = stakeVector.payloadUtf8;
    const domain = `link_stake:${claimantId}`;

    const result = await handleLinkStake(
      {
        db: env.DB,
        userId: claimantId,
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
        },
        network: 'preprod',
        now: 1_700_000_000,
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(fixturePayload, domain) },
    );

    expect(result.status).toBe(409);
    expect((result.json as { ok: boolean }).ok).toBe(false);

    const claimant = await getUserById(env.DB, claimantId);
    expect(claimant?.stake_addr).toBeNull();
    const owner = await getUserById(env.DB, ownerId);
    expect(owner?.stake_addr).toBe(STAKE_ADDR);
  });
});

describe('handleLinkStake: wrong nonce domain', () => {
  it('returns 401 when the domain does not match the calling user id', async () => {
    const userId = 'writer-wrong-domain-1';
    await insertUser(userId, null);

    const fixturePayload = stakeVector.payloadUtf8;
    // The override was "issued" for a completely different user's domain, so
    // the domain handleLinkStake derives from `userId` will not match, and
    // the nonce must be rejected -- this is the property that prevents one
    // user's link-challenge nonce from being redeemed under another account.
    const issuedForDomain = 'link_stake:some-other-user';

    const result = await handleLinkStake(
      {
        db: env.DB,
        userId,
        body: {
          payload: fixturePayload,
          signatureHex: stakeVector.signatureHex,
          keyHex: stakeVector.keyHex,
        },
        network: 'preprod',
        now: 1_700_000_000,
      },
      { consumeNonceForDomain: makeDomainScopedNonceOverride(fixturePayload, issuedForDomain) },
    );

    expect(result.status).toBe(401);
    expect((result.json as { ok: boolean }).ok).toBe(false);

    const row = await getUserById(env.DB, userId);
    expect(row?.stake_addr).toBeNull(); // never linked
  });
});
