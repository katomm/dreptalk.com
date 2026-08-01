// Proposer grants D1 access tests, runs in real workerd via @cloudflare/vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  GRANT_INVITE_TTL_SEC,
  MAX_GRANTS_PER_PROPOSER,
  createGrantInvite,
  lookupInviteByCode,
  redeemGrant,
  getActiveGrantByCoStake,
  isGrantActiveForUser,
  getGrantsForProposer,
  getGrantsByIds,
  revokeGrant,
  withdrawInvite,
} from './proposerGrants.js';
import { upsertUserFromAuth } from './users.js';

const db = () => env.DB as D1Database;
const NOW = 1_700_000_000;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `${NOW}-${seq}`;
}

async function makeProposer(): Promise<{ userId: string; stakeAddr: string }> {
  const stakeAddr = `stake_test1-proposer-${nextId()}`;
  const user = await upsertUserFromAuth(db(), { stakeAddr, roles: ['proposer'], now: NOW });
  return { userId: user.id, stakeAddr };
}

async function makeCoUser(): Promise<{ userId: string; stakeAddr: string }> {
  const stakeAddr = `stake_test1-co-${nextId()}`;
  const user = await upsertUserFromAuth(db(), { stakeAddr, roles: [], now: NOW });
  return { userId: user.id, stakeAddr };
}

describe('createGrantInvite', () => {
  it('creates a pending grant and returns the plain code once', async () => {
    const proposer = await makeProposer();
    const result = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.grantId).toBeTruthy();
    expect(result!.inviteCode).toBeTruthy();
    expect(result!.expiresAt).toBe(NOW + GRANT_INVITE_TTL_SEC);

    const row = await db()
      .prepare('SELECT invite_code_hash, status FROM proposer_grants WHERE id = ?1')
      .bind(result!.grantId)
      .first<{ invite_code_hash: string; status: string }>();
    expect(row).not.toBeNull();
    expect(row!.invite_code_hash).not.toBe(result!.inviteCode);
    expect(row!.status).toBe('pending');
  });

  it('returns null for the 3rd invite (2 pending)', async () => {
    const proposer = await makeProposer();
    const a = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    const b = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const c = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    expect(c).toBeNull();
  });

  it('counts active + unexpired pending toward the limit', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    const redeemed = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(redeemed.ok).toBe(true);

    const second = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    expect(second).not.toBeNull();

    const third = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    expect(third).toBeNull();
  });

  it('lets an expired pending invite free its slot and sweeps it', async () => {
    const proposer = await makeProposer();
    const OLD = NOW - GRANT_INVITE_TTL_SEC - 1;
    const a = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: OLD,
    });
    const b = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: OLD,
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    // Both prior invites are expired by NOW; the limit check must not count
    // them, and the sweep must delete them from the table.
    const c = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    expect(c).not.toBeNull();

    const count = await db()
      .prepare('SELECT COUNT(*) AS n FROM proposer_grants WHERE proposer_user_id = ?1')
      .bind(proposer.userId)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('two concurrent creates at 1 existing grant: exactly one succeeds', async () => {
    const proposer = await makeProposer();
    // Seed one active grant directly so the table starts at exactly 1 toward
    // the limit of 2, with no earlier createGrantInvite call in the mix.
    await db()
      .prepare(
        `INSERT INTO proposer_grants
           (id, proposer_user_id, proposer_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at)
         VALUES (?1, ?2, ?3, 'seed-hash', 'active', ?4, ?5, ?4)`,
      )
      .bind(nextId(), proposer.userId, proposer.stakeAddr, NOW, NOW + GRANT_INVITE_TTL_SEC)
      .run();

    const [a, b] = await Promise.all([
      createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, now: NOW }),
      createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, now: NOW }),
    ]);
    const successes = [a, b].filter((r) => r !== null);
    expect(successes).toHaveLength(1);
  });
});

describe('lookupInviteByCode', () => {
  it('finds pending unexpired, misses expired/redeemed/garbage', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    const found = await lookupInviteByCode(db(), invite!.inviteCode, { now: NOW });
    expect(found).toEqual({ grantId: invite!.grantId, proposerStakeAddr: proposer.stakeAddr });

    expect(await lookupInviteByCode(db(), 'not-a-real-code', { now: NOW })).toBeNull();
    expect(
      await lookupInviteByCode(db(), invite!.inviteCode, { now: NOW + GRANT_INVITE_TTL_SEC + 1 }),
    ).toBeNull();

    const coUser = await makeCoUser();
    await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(await lookupInviteByCode(db(), invite!.inviteCode, { now: NOW })).toBeNull();
  });
});

describe('redeemGrant', () => {
  it('activates, stamps co_user_id/co_stake_addr/redeemed_at, fills an empty display_name', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    const result = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co Proposer',
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
    });

    const row = await db()
      .prepare('SELECT status, co_user_id, co_stake_addr, redeemed_at FROM proposer_grants WHERE id = ?1')
      .bind(invite!.grantId)
      .first<{ status: string; co_user_id: string; co_stake_addr: string; redeemed_at: number }>();
    expect(row).toEqual({
      status: 'active',
      co_user_id: coUser.userId,
      co_stake_addr: coUser.stakeAddr,
      redeemed_at: NOW,
    });

    const userRow = await db()
      .prepare('SELECT display_name FROM users WHERE id = ?1')
      .bind(coUser.userId)
      .first<{ display_name: string }>();
    expect(userRow!.display_name).toBe('Co Proposer');
  });

  it('does not overwrite an existing non-empty display_name', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    await db()
      .prepare('UPDATE users SET display_name = ?1 WHERE id = ?2')
      .bind('Already Named', coUser.userId)
      .run();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'New Name',
      now: NOW,
    });

    const userRow = await db()
      .prepare('SELECT display_name FROM users WHERE id = ?1')
      .bind(coUser.userId)
      .first<{ display_name: string }>();
    expect(userRow!.display_name).toBe('Already Named');
  });

  it('double redeem: second call returns unavailable', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const otherCoUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    const first = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(first.ok).toBe(true);

    const second = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: otherCoUser.userId,
      coStakeAddr: otherCoUser.stakeAddr,
      displayName: 'Other',
      now: NOW,
    });
    expect(second).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('redeem of expired invite returns unavailable', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    const result = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW + GRANT_INVITE_TTL_SEC + 1,
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('second grant activating the same co_stake_addr returns mandate_taken', async () => {
    const proposerA = await makeProposer();
    const proposerB = await makeProposer();
    const coUser = await makeCoUser();
    const inviteA = await createGrantInvite(db(), {
      proposerUserId: proposerA.userId,
      proposerStakeAddr: proposerA.stakeAddr,
      now: NOW,
    });
    const inviteB = await createGrantInvite(db(), {
      proposerUserId: proposerB.userId,
      proposerStakeAddr: proposerB.stakeAddr,
      now: NOW,
    });

    const first = await redeemGrant(db(), {
      grantId: inviteA!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(first.ok).toBe(true);

    const second = await redeemGrant(db(), {
      grantId: inviteB!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(second).toEqual({ ok: false, reason: 'mandate_taken' });
  });

  it("redeeming with the proposer's own stake address returns { ok: false, reason: 'self' }", async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    const result = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: proposer.userId,
      coStakeAddr: proposer.stakeAddr,
      displayName: 'Self',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'self' });

    const row = await db()
      .prepare('SELECT status FROM proposer_grants WHERE id = ?1')
      .bind(invite!.grantId)
      .first<{ status: string }>();
    expect(row!.status).toBe('pending');
  });
});

describe('getActiveGrantByCoStake', () => {
  it('returns the active grant, null after revoke', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });

    const active = await getActiveGrantByCoStake(db(), coUser.stakeAddr);
    expect(active).not.toBeNull();
    expect(active!.id).toBe(invite!.grantId);
    expect(active!.status).toBe('active');

    const revoked = await revokeGrant(db(), { grantId: invite!.grantId, proposerUserId: proposer.userId, now: NOW });
    expect(revoked).toBe(true);

    expect(await getActiveGrantByCoStake(db(), coUser.stakeAddr)).toBeNull();
  });
});

describe('isGrantActiveForUser', () => {
  it('true only for status=active AND matching co_user_id', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const otherUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    expect(await isGrantActiveForUser(db(), invite!.grantId, coUser.userId)).toBe(false);

    await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });

    expect(await isGrantActiveForUser(db(), invite!.grantId, coUser.userId)).toBe(true);
    expect(await isGrantActiveForUser(db(), invite!.grantId, otherUser.userId)).toBe(false);
  });
});

describe('getGrantsForProposer', () => {
  it('lists active + unexpired pending, hides expired, newest first', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();

    const activeInvite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW - 20,
    });
    await redeemGrant(db(), {
      grantId: activeInvite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW - 20,
    });

    const pendingInvite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW - 10,
    });

    // A third, expired pending row is inserted directly (createGrantInvite
    // would refuse a 3rd row and sweep expired ones on its own).
    const expiredId = nextId();
    await db()
      .prepare(
        `INSERT INTO proposer_grants
           (id, proposer_user_id, proposer_stake_addr, invite_code_hash, status, created_at, expires_at)
         VALUES (?1, ?2, ?3, 'expired-hash', 'pending', ?4, ?5)`,
      )
      .bind(expiredId, proposer.userId, proposer.stakeAddr, NOW - 30, NOW - 1)
      .run();

    const grants = await getGrantsForProposer(db(), proposer.userId, { now: NOW });
    expect(grants.map((g) => g.id)).toEqual([pendingInvite!.grantId, activeInvite!.grantId]);
    expect(grants.every((g) => g.id !== expiredId)).toBe(true);
  });
});

describe('getGrantsByIds', () => {
  it('batches lookups by id', async () => {
    const proposer = await makeProposer();
    const a = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    const b = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    const map = await getGrantsByIds(db(), [a!.grantId, b!.grantId, 'no-such-id']);
    expect(map.size).toBe(2);
    expect(map.get(a!.grantId)?.id).toBe(a!.grantId);
    expect(map.get(b!.grantId)?.id).toBe(b!.grantId);
    expect(map.has('no-such-id')).toBe(false);
  });

  it('returns an empty map for empty input without querying D1', async () => {
    expect((await getGrantsByIds(db(), [])).size).toBe(0);
  });
});

describe('revokeGrant', () => {
  it('flips active->revoked only for the owning proposer', async () => {
    const proposer = await makeProposer();
    const otherProposer = await makeProposer();
    const coUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });

    expect(await revokeGrant(db(), { grantId: invite!.grantId, proposerUserId: otherProposer.userId, now: NOW })).toBe(
      false,
    );
    const stillActive = await db()
      .prepare('SELECT status FROM proposer_grants WHERE id = ?1')
      .bind(invite!.grantId)
      .first<{ status: string }>();
    expect(stillActive!.status).toBe('active');

    expect(await revokeGrant(db(), { grantId: invite!.grantId, proposerUserId: proposer.userId, now: NOW })).toBe(
      true,
    );
    const row = await db()
      .prepare('SELECT status, revoked_at FROM proposer_grants WHERE id = ?1')
      .bind(invite!.grantId)
      .first<{ status: string; revoked_at: number }>();
    expect(row).toEqual({ status: 'revoked', revoked_at: NOW });
  });

  it('is idempotent: true again for an already-revoked owned grant, false for foreign/pending', async () => {
    const proposer = await makeProposer();
    const otherProposer = await makeProposer();
    const coUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });

    expect(await revokeGrant(db(), { grantId: invite!.grantId, proposerUserId: proposer.userId, now: NOW })).toBe(
      true,
    );
    // Retry (e.g. after a failed KV cleanup step) must still report success.
    expect(await revokeGrant(db(), { grantId: invite!.grantId, proposerUserId: proposer.userId, now: NOW })).toBe(
      true,
    );
    // A foreign proposer never gets true, even for an already-revoked grant.
    expect(
      await revokeGrant(db(), { grantId: invite!.grantId, proposerUserId: otherProposer.userId, now: NOW }),
    ).toBe(false);

    // A still-pending grant (never activated) cannot be revoked by its owner.
    const pendingInvite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    expect(
      await revokeGrant(db(), { grantId: pendingInvite!.grantId, proposerUserId: proposer.userId, now: NOW }),
    ).toBe(false);
  });
});

describe('withdrawInvite', () => {
  it('deletes pending only for the owning proposer, never active', async () => {
    const proposer = await makeProposer();
    const otherProposer = await makeProposer();
    const coUser = await makeCoUser();
    const pendingInvite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });

    expect(
      await withdrawInvite(db(), { grantId: pendingInvite!.grantId, proposerUserId: otherProposer.userId }),
    ).toBe(false);
    const stillThere = await db()
      .prepare('SELECT id FROM proposer_grants WHERE id = ?1')
      .bind(pendingInvite!.grantId)
      .first();
    expect(stillThere).not.toBeNull();

    expect(
      await withdrawInvite(db(), { grantId: pendingInvite!.grantId, proposerUserId: proposer.userId }),
    ).toBe(true);
    const gone = await db()
      .prepare('SELECT id FROM proposer_grants WHERE id = ?1')
      .bind(pendingInvite!.grantId)
      .first();
    expect(gone).toBeNull();

    const activeInvite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      now: NOW,
    });
    await redeemGrant(db(), {
      grantId: activeInvite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(
      await withdrawInvite(db(), { grantId: activeInvite!.grantId, proposerUserId: proposer.userId }),
    ).toBe(false);
    const stillActive = await db()
      .prepare('SELECT status FROM proposer_grants WHERE id = ?1')
      .bind(activeInvite!.grantId)
      .first<{ status: string }>();
    expect(stillActive!.status).toBe('active');
  });
});

describe('constants', () => {
  it('exposes the documented TTL and per-proposer limit', () => {
    expect(GRANT_INVITE_TTL_SEC).toBe(604800);
    expect(MAX_GRANTS_PER_PROPOSER).toBe(2);
  });
});
