// Proposer grants D1 access tests, runs in real workerd via @cloudflare/vitest-plugin.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  GRANT_INVITE_TTL_SEC,
  createGrantInvite,
  lookupInviteByCode,
  redeemGrant,
  listActiveGrantsForCoUser,
  hasActiveGrantForCoUser,
  getActiveGrantIdForTopic,
  isGrantActiveForUser,
  getGrantsForProposerActions,
  getGrantsByIds,
  revokeGrant,
  withdrawInvite,
} from './proposerGrants.js';
import { upsertUserFromAuth } from './users.js';
import { loadMandates } from '../forum/mandate.js';

const db = () => env.DB as D1Database;
const NOW = 1_700_000_000;
const ACTION_X = `${'a'.repeat(64)}#0`;
const ACTION_Y = `${'b'.repeat(64)}#1`;

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
      govActionId: ACTION_X,
      teamLabel: null,
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

  it('caps at 4 grants per action and counts per action', async () => {
    const proposer = await makeProposer();
    const args = (govActionId: string) => ({
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId,
      teamLabel: null,
      now: NOW,
    });
    for (let i = 0; i < 4; i++) expect(await createGrantInvite(db(), args(ACTION_X))).not.toBeNull();
    expect(await createGrantInvite(db(), args(ACTION_X))).toBeNull();
    expect(await createGrantInvite(db(), args(ACTION_Y))).not.toBeNull();
  });

  it('counts active grants toward the action limit', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const args = {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
      now: NOW,
    };
    const invite = await createGrantInvite(db(), args);
    const redeemed = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(redeemed.ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(await createGrantInvite(db(), args)).not.toBeNull();
    expect(await createGrantInvite(db(), args)).toBeNull();
  });

  it('expired pending invites free a slot and are swept', async () => {
    const proposer = await makeProposer();
    const OLD = NOW - GRANT_INVITE_TTL_SEC - 1;
    const old = {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
      now: OLD,
    };
    for (let i = 0; i < 4; i++) expect(await createGrantInvite(db(), old)).not.toBeNull();
    expect(await createGrantInvite(db(), old)).toBeNull();

    // All four prior invites are expired by NOW; the limit check must not count
    // them, and the sweep must delete them from the table.
    const c = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
      now: NOW,
    });
    expect(c).not.toBeNull();

    const count = await db()
      .prepare('SELECT COUNT(*) AS n FROM proposer_grants WHERE proposer_user_id = ?1')
      .bind(proposer.userId)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('two concurrent creates at 3 existing grants: exactly one succeeds', async () => {
    const proposer = await makeProposer();
    // Seed three active grants directly so the action starts at exactly 3
    // toward the limit of 4, with no earlier createGrantInvite call in the mix.
    for (let i = 0; i < 3; i++) {
      await db()
        .prepare(
          `INSERT INTO proposer_grants
             (id, proposer_user_id, proposer_stake_addr, gov_action_id, invite_code_hash, status, created_at, expires_at, redeemed_at)
           VALUES (?1, ?2, ?3, ?6, ?1, 'active', ?4, ?5, ?4)`,
        )
        .bind(nextId(), proposer.userId, proposer.stakeAddr, NOW, NOW + GRANT_INVITE_TTL_SEC, ACTION_X)
        .run();
    }

    const [a, b] = await Promise.all([
      createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, govActionId: ACTION_X, teamLabel: null, now: NOW }),
      createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, govActionId: ACTION_X, teamLabel: null, now: NOW }),
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
      govActionId: ACTION_X,
      teamLabel: null,
      now: NOW,
    });

    const found = await lookupInviteByCode(db(), invite!.inviteCode, { now: NOW });
    expect(found).toEqual({
      grantId: invite!.grantId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
    });

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

describe('lookupInviteByCode team label', () => {
  it('returns the action id and team label', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_Y,
      teamLabel: 'Treasury team',
      now: NOW,
    });
    expect(await lookupInviteByCode(db(), invite!.inviteCode, { now: NOW })).toEqual({
      grantId: invite!.grantId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_Y,
      teamLabel: 'Treasury team',
    });
  });
});

describe('redeemGrant', () => {
  it('activates, stamps co_user_id/co_stake_addr/redeemed_at, fills an empty display_name', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
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
      govActionId: ACTION_X,
      teamLabel: null,
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
      govActionId: ACTION_X,
      teamLabel: null,
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
      govActionId: ACTION_X,
      teamLabel: null,
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
      govActionId: ACTION_X,
      teamLabel: null,
      now: NOW,
    });
    const inviteB = await createGrantInvite(db(), {
      proposerUserId: proposerB.userId,
      proposerStakeAddr: proposerB.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
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

  it('second redeem for the same action reports mandate_taken and deletes the losing pending row', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const args = {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
      now: NOW,
    };
    const first = await createGrantInvite(db(), args);
    const second = await createGrantInvite(db(), args);
    const redeem = (grantId: string) =>
      redeemGrant(db(), {
        grantId,
        coUserId: coUser.userId,
        coStakeAddr: coUser.stakeAddr,
        displayName: 'Co',
        now: NOW,
      });
    expect((await redeem(first!.grantId)).ok).toBe(true);
    expect(await redeem(second!.grantId)).toEqual({ ok: false, reason: 'mandate_taken' });

    const pending = await db()
      .prepare(`SELECT COUNT(*) AS n FROM proposer_grants WHERE gov_action_id = ?1 AND status = 'pending'`)
      .bind(ACTION_X)
      .first<{ n: number }>();
    // Other tests share the database, so only this proposer's rows are asserted.
    const mine = await db()
      .prepare(`SELECT COUNT(*) AS n FROM proposer_grants WHERE proposer_user_id = ?1 AND status = 'pending'`)
      .bind(proposer.userId)
      .first<{ n: number }>();
    expect(mine!.n).toBe(0);
    expect(pending!.n).toBe(0);
  });

  it('one stake key can hold active grants for two actions', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    for (const govActionId of [ACTION_X, ACTION_Y]) {
      const invite = await createGrantInvite(db(), {
        proposerUserId: proposer.userId,
        proposerStakeAddr: proposer.stakeAddr,
        govActionId,
        teamLabel: null,
        now: NOW,
      });
      const result = await redeemGrant(db(), {
        grantId: invite!.grantId,
        coUserId: coUser.userId,
        coStakeAddr: coUser.stakeAddr,
        displayName: 'Co',
        now: NOW,
      });
      expect(result.ok).toBe(true);
    }
    const rows = await db()
      .prepare(`SELECT gov_action_id, status FROM proposer_grants WHERE co_user_id = ?1 ORDER BY gov_action_id`)
      .bind(coUser.userId)
      .all<{ gov_action_id: string; status: string }>();
    expect(rows.results).toEqual([
      { gov_action_id: ACTION_X, status: 'active' },
      { gov_action_id: ACTION_Y, status: 'active' },
    ]);
  });

  it("redeeming with the proposer's own stake address returns { ok: false, reason: 'self' }", async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
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

describe('co-user grant reads', () => {
  it('getActiveGrantIdForTopic ignores revoked grants and other threads', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const topicX = `topic-x-${nextId()}`;
    const actionX = `${'c'.repeat(63)}${seq % 10}#0`;
    await db()
      .prepare(
        `INSERT INTO governance_actions (id, type, title, status, return_address, topic_id, created_at, last_synced_at)
         VALUES (?1, 'InfoAction', 't', 'active', 'x', ?2, 1, 1)`,
      )
      .bind(actionX, topicX)
      .run();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: actionX,
      teamLabel: null,
      now: NOW,
    });
    await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });

    expect(await getActiveGrantIdForTopic(db(), coUser.userId, topicX)).toBe(invite!.grantId);
    expect(await getActiveGrantIdForTopic(db(), coUser.userId, 'some-other-topic')).toBeNull();
    expect(await hasActiveGrantForCoUser(db(), coUser.userId)).toBe(true);

    expect(await revokeGrant(db(), { grantId: invite!.grantId, proposerUserId: proposer.userId, now: NOW })).toBe(true);
    expect(await getActiveGrantIdForTopic(db(), coUser.userId, topicX)).toBeNull();
    expect(await hasActiveGrantForCoUser(db(), coUser.userId)).toBe(false);
    expect(await listActiveGrantsForCoUser(db(), coUser.userId)).toEqual([]);
  });

  it('listActiveGrantsForCoUser returns active grants oldest first', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const ids: string[] = [];
    for (const [i, govActionId] of [ACTION_Y, ACTION_X].entries()) {
      const invite = await createGrantInvite(db(), {
        proposerUserId: proposer.userId,
        proposerStakeAddr: proposer.stakeAddr,
        govActionId,
        teamLabel: null,
        now: NOW + i,
      });
      await redeemGrant(db(), {
        grantId: invite!.grantId,
        coUserId: coUser.userId,
        coStakeAddr: coUser.stakeAddr,
        displayName: 'Co',
        now: NOW + i,
      });
      ids.push(invite!.grantId);
    }
    const grants = await listActiveGrantsForCoUser(db(), coUser.userId);
    expect(grants.map((g) => g.id)).toEqual(ids);
  });
});

describe('rows without gov_action_id', () => {
  it('are invisible, ignored by the cap, and swept by the next invite', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const insertLegacy = (id: string, status: 'active' | 'pending') =>
      db()
        .prepare(
          `INSERT INTO proposer_grants
             (id, proposer_user_id, proposer_stake_addr, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?1, ?6, ?7, ?8, ?7)`,
        )
        .bind(
          id,
          proposer.userId,
          proposer.stakeAddr,
          status === 'active' ? coUser.userId : null,
          status === 'active' ? coUser.stakeAddr : null,
          status,
          NOW,
          NOW + GRANT_INVITE_TTL_SEC,
        )
        .run();
    const activeId = nextId();
    const pendingId = nextId();
    await insertLegacy(activeId, 'active');
    await insertLegacy(pendingId, 'pending');

    expect(await isGrantActiveForUser(db(), activeId, coUser.userId)).toBe(false);
    expect(await hasActiveGrantForCoUser(db(), coUser.userId)).toBe(false);
    expect(await listActiveGrantsForCoUser(db(), coUser.userId)).toEqual([]);
    expect((await getGrantsByIds(db(), [activeId, pendingId])).size).toBe(0);
    expect((await getGrantsForProposerActions(db(), proposer.userId, { now: NOW })).size).toBe(0);

    // Unredeemable even though pending and unexpired.
    const redeemed = await redeemGrant(db(), {
      grantId: pendingId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW,
    });
    expect(redeemed).toEqual({ ok: false, reason: 'unavailable' });

    // They do not count toward the cap: four fresh invites still fit.
    const args = {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
      now: NOW,
    };
    for (let i = 0; i < 4; i++) expect(await createGrantInvite(db(), args)).not.toBeNull();

    const left = await db()
      .prepare('SELECT COUNT(*) AS n FROM proposer_grants WHERE id IN (?1, ?2)')
      .bind(activeId, pendingId)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
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
      govActionId: ACTION_X,
      teamLabel: null,
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

describe('getGrantsForProposerActions', () => {
  it('groups active + unexpired pending by action, hides expired, newest first', async () => {
    const proposer = await makeProposer();
    const coUser = await makeCoUser();
    const base = { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, teamLabel: null };

    const activeInvite = await createGrantInvite(db(), { ...base, govActionId: ACTION_X, now: NOW - 20 });
    await redeemGrant(db(), {
      grantId: activeInvite!.grantId,
      coUserId: coUser.userId,
      coStakeAddr: coUser.stakeAddr,
      displayName: 'Co',
      now: NOW - 20,
    });
    const pendingInvite = await createGrantInvite(db(), { ...base, govActionId: ACTION_X, now: NOW - 10 });
    const otherActionInvite = await createGrantInvite(db(), { ...base, govActionId: ACTION_Y, now: NOW - 5 });

    // An expired pending row is inserted directly (createGrantInvite would
    // sweep it on its own).
    const expiredId = nextId();
    await db()
      .prepare(
        `INSERT INTO proposer_grants
           (id, proposer_user_id, proposer_stake_addr, gov_action_id, invite_code_hash, status, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, 'expired-hash', 'pending', ?5, ?6)`,
      )
      .bind(expiredId, proposer.userId, proposer.stakeAddr, ACTION_X, NOW - 30, NOW - 1)
      .run();

    const grants = await getGrantsForProposerActions(db(), proposer.userId, { now: NOW });
    expect([...grants.keys()].sort()).toEqual([ACTION_X, ACTION_Y]);
    expect(grants.get(ACTION_X)!.map((g) => g.id)).toEqual([pendingInvite!.grantId, activeInvite!.grantId]);
    expect(grants.get(ACTION_Y)!.map((g) => g.id)).toEqual([otherActionInvite!.grantId]);
  });
});

describe('getGrantsByIds', () => {
  it('batches lookups by id', async () => {
    const proposer = await makeProposer();
    const a = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
      now: NOW,
    });
    const b = await createGrantInvite(db(), {
      proposerUserId: proposer.userId,
      proposerStakeAddr: proposer.stakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
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

  it('still returns a revoked grant, so its mandate badge keeps resolving', async () => {
    // Real curated address (config/proposers.ts), so the label is the curated name.
    const proposerStakeAddr = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
    const proposer = await upsertUserFromAuth(db(), { stakeAddr: proposerStakeAddr, roles: ['proposer'], now: NOW });
    const co = await makeCoUser();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.id,
      proposerStakeAddr,
      govActionId: ACTION_X,
      teamLabel: null,
      now: NOW,
    });
    const redeemed = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: co.userId,
      coStakeAddr: co.stakeAddr,
      displayName: 'Co Proposer',
      now: NOW,
    });
    expect(redeemed.ok).toBe(true);
    expect(await revokeGrant(db(), { grantId: invite!.grantId, proposerUserId: proposer.id, now: NOW })).toBe(true);

    const map = await getGrantsByIds(db(), [invite!.grantId]);
    expect(map.get(invite!.grantId)?.status).toBe('revoked');
    // loadMandates with its default fetch reads through getGrantsByIds.
    expect((await loadMandates(db(), [invite!.grantId], null)).get(invite!.grantId)?.label).toBe('for Intersect');
  });

  it('loadMandates reads governance_actions.topic_id: team badge in the action thread, "for" elsewhere', async () => {
    const proposerStakeAddr = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
    const proposer = await upsertUserFromAuth(db(), { stakeAddr: proposerStakeAddr, roles: ['proposer'], now: NOW });
    const co = await makeCoUser();
    await db()
      .prepare(
        `INSERT INTO governance_actions (id, type, title, status, return_address, topic_id, created_at, last_synced_at)
         VALUES (?1, 'InfoAction', 't', 'active', 'x', 'topic-of-x', 1, 1)`,
      )
      .bind(ACTION_X)
      .run();
    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.id,
      proposerStakeAddr,
      govActionId: ACTION_X,
      teamLabel: 'Trivolve Tech',
      now: NOW,
    });
    await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: co.userId,
      coStakeAddr: co.stakeAddr,
      displayName: 'Co Proposer',
      now: NOW,
    });

    const inThread = await loadMandates(db(), [invite!.grantId], 'topic-of-x');
    expect(inThread.get(invite!.grantId)).toEqual({
      label: 'Proposer team \u00b7 Trivolve Tech',
      title: 'Invited by Intersect, which submitted this action',
    });
    const elsewhere = await loadMandates(db(), [invite!.grantId], 'some-draft-topic');
    expect(elsewhere.get(invite!.grantId)).toEqual({ label: 'for Intersect', title: null });
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
      govActionId: ACTION_X,
      teamLabel: null,
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
      govActionId: ACTION_X,
      teamLabel: null,
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
      govActionId: ACTION_X,
      teamLabel: null,
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
      govActionId: ACTION_X,
      teamLabel: null,
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
      govActionId: ACTION_X,
      teamLabel: null,
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
