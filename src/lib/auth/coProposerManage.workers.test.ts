// Workers-runtime tests for the proposer-facing co-proposer management
// handlers: create invite, revoke an active grant, withdraw a pending one.
// Runs in real workerd via @cloudflare/vitest-pool-workers, using the real
// D1/KV bindings, mirroring coProposerRedeem.workers.test.ts's setup.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleCreateInvite, handleRevokeGrant, handleWithdrawInvite } from './coProposerManage.js';
import { createGrantInvite, getGrantsForProposer, withdrawInvite } from '../db/proposerGrants.js';
import { upsertUserFromAuth } from '../db/users.js';
import { createSession, getSession } from './session.js';

const db = () => env.DB as D1Database;
const NOW = 1_700_000_000;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `${NOW}-${seq}`;
}

/** Creates a real on-chain proposer account (is_proposer = true). */
async function makeProposer(opts?: { stakeAddr?: string }) {
  const stakeAddr = opts?.stakeAddr ?? `stake_test1-proposer-${nextId()}`;
  const row = await upsertUserFromAuth(db(), { stakeAddr, roles: ['proposer'], now: NOW });
  return { userId: row.id, stakeAddr };
}

/** Creates a plain member account (is_proposer = false). */
async function makeMember() {
  const stakeAddr = `stake_test1-member-${nextId()}`;
  const row = await upsertUserFromAuth(db(), { stakeAddr, roles: [], now: NOW });
  return { userId: row.id, stakeAddr };
}

/** A session-shaped user object, the same fields coProposerManage reads off locals.user. */
function sessionUser(id: string, roles: string[], grantId?: string | null) {
  return { id, roles, grantId };
}

/** A KV whose delete/get throw exactly once, to simulate a transient KV outage. */
function flakyKv(real: KVNamespace): KVNamespace {
  let failNext = true;
  return {
    get: async (...args: Parameters<KVNamespace['get']>) => {
      if (failNext) {
        failNext = false;
        throw new Error('kv unavailable');
      }
      return (real.get as (...a: unknown[]) => unknown)(...args);
    },
    put: (...args: Parameters<KVNamespace['put']>) => real.put(...args),
    delete: (...args: Parameters<KVNamespace['delete']>) => real.delete(...args),
    list: (...args: Parameters<KVNamespace['list']>) => (real.list as (...a: unknown[]) => unknown)(...args),
  } as unknown as KVNamespace;
}

describe('handleCreateInvite: guard enforcement', () => {
  it('403s for a grant session even though it holds the proposer role', async () => {
    const proposer = await makeProposer();
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer'], 'some-grant-id'),
      now: NOW,
    });
    expect(result.status).toBe(403);
  });

  it('403s for a member-capped session of a user whose row has is_proposer (delegator door)', async () => {
    const proposer = await makeProposer();
    // The row is a real proposer, but this particular session only holds the
    // member-capped role set a delegator-door login mints.
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['member'], null),
      now: NOW,
    });
    expect(result.status).toBe(403);
  });

  it('403s for a proposer-role session whose row is not actually a proposer', async () => {
    const member = await makeMember();
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(member.userId, ['proposer'], null),
      now: NOW,
    });
    expect(result.status).toBe(403);
  });

  it('200s with an invite url for a real proposer session + row', async () => {
    const proposer = await makeProposer();
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer'], null),
      now: NOW,
    });
    expect(result.status).toBe(200);
    const json = result.json as { inviteUrl: string; expiresAt: number };
    expect(json.inviteUrl).toMatch(/^\/co-proposer\/redeem\?code=/);
    expect(json.expiresAt).toBeGreaterThan(NOW);
  });

  it('409s at the 2-grant limit', async () => {
    const proposer = await makeProposer();
    const first = await handleCreateInvite({ db: db(), user: sessionUser(proposer.userId, ['proposer'], null), now: NOW });
    const second = await handleCreateInvite({ db: db(), user: sessionUser(proposer.userId, ['proposer'], null), now: NOW });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const third = await handleCreateInvite({ db: db(), user: sessionUser(proposer.userId, ['proposer'], null), now: NOW });
    expect(third.status).toBe(409);
    expect((third.json as { error: string }).error).toBe('limit reached');
  });

  it('500s when proposer row lacks a stake address', async () => {
    const proposer = await makeProposer();
    // Clear the stake_addr to simulate a malformed row that lacks the proposer identity.
    await db().prepare('UPDATE users SET stake_addr = NULL WHERE id = ?1').bind(proposer.userId).run();
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer'], null),
      now: NOW,
    });
    expect(result.status).toBe(500);
    expect((result.json as { error: string }).error).toBe('internal error');

    // Verify no grant row was created.
    const grants = await getGrantsForProposer(db(), proposer.userId, { now: NOW });
    expect(grants).toHaveLength(0);
  });
});

describe('handleRevokeGrant', () => {
  it('revokes only for the owning proposer; kills gsess sessions; pending grants cannot be revoked, only withdrawn', async () => {
    const proposer = await makeProposer();
    const otherProposer = await makeProposer();

    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');

    // A pending (never redeemed) grant cannot be revoked.
    const pendingAttempt = await handleRevokeGrant({
      db: db(),
      sessionKv: env.SESSIONS,
      user: sessionUser(proposer.userId, ['proposer'], null),
      grantId: invite.grantId,
      now: NOW,
    });
    expect(pendingAttempt.status).toBe(404);

    // Redeem it so it becomes active, and mint a grant-backed session for it.
    const coStakeAddr = `stake_test1-co-${nextId()}`;
    const coRow = await upsertUserFromAuth(db(), { stakeAddr: coStakeAddr, roles: [], now: NOW });
    await db()
      .prepare(`UPDATE proposer_grants SET status = 'active', co_user_id = ?1, co_stake_addr = ?2, redeemed_at = ?3 WHERE id = ?4`)
      .bind(coRow.id, coStakeAddr, NOW, invite.grantId)
      .run();
    const token = await createSession(env.SESSIONS, {
      id: coRow.id,
      roles: ['proposer'],
      grantId: invite.grantId,
      actsFor: { userId: proposer.userId, stakeAddr: proposer.stakeAddr },
    });
    expect(await getSession(env.SESSIONS, token)).not.toBeNull();

    // A different real proposer cannot revoke someone else's grant.
    const wrongOwner = await handleRevokeGrant({
      db: db(),
      sessionKv: env.SESSIONS,
      user: sessionUser(otherProposer.userId, ['proposer'], null),
      grantId: invite.grantId,
      now: NOW,
    });
    expect(wrongOwner.status).toBe(404);
    // The grant-backed session must survive a revoke attempt that never
    // actually owned the grant.
    expect(await getSession(env.SESSIONS, token)).not.toBeNull();

    // The owning proposer can revoke it, and doing so kills the grant session.
    const result = await handleRevokeGrant({
      db: db(),
      sessionKv: env.SESSIONS,
      user: sessionUser(proposer.userId, ['proposer'], null),
      grantId: invite.grantId,
      now: NOW,
    });
    expect(result.status).toBe(200);
    expect(await getSession(env.SESSIONS, token)).toBeNull();

    const grants = await getGrantsForProposer(db(), proposer.userId, { now: NOW });
    expect(grants.find((g) => g.id === invite.grantId)).toBeUndefined();
  });

  it('retry heals a failed KV cleanup: first call flips D1 but KV throws, second call reports success and removes the remaining grant sessions', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');

    const coStakeAddr = `stake_test1-co-${nextId()}`;
    const coRow = await upsertUserFromAuth(db(), { stakeAddr: coStakeAddr, roles: [], now: NOW });
    await db()
      .prepare(`UPDATE proposer_grants SET status = 'active', co_user_id = ?1, co_stake_addr = ?2, redeemed_at = ?3 WHERE id = ?4`)
      .bind(coRow.id, coStakeAddr, NOW, invite.grantId)
      .run();
    const token = await createSession(env.SESSIONS, {
      id: coRow.id,
      roles: ['proposer'],
      grantId: invite.grantId,
      actsFor: { userId: proposer.userId, stakeAddr: proposer.stakeAddr },
    });

    const kv = flakyKv(env.SESSIONS);
    const firstAttempt = await handleRevokeGrant({
      db: db(),
      sessionKv: kv,
      user: sessionUser(proposer.userId, ['proposer'], null),
      grantId: invite.grantId,
      now: NOW,
    });
    expect(firstAttempt.status).toBe(500);

    // D1 already flipped even though the first call reported failure.
    const grantsAfterFirst = await getGrantsForProposer(db(), proposer.userId, { now: NOW });
    expect(grantsAfterFirst.find((g) => g.id === invite.grantId)).toBeUndefined();
    expect(await getSession(env.SESSIONS, token)).not.toBeNull();

    // Retrying (against the real, non-flaky KV) heals the KV side: revokeGrant
    // is idempotent for an owned revoked grant, so this reports success.
    const secondAttempt = await handleRevokeGrant({
      db: db(),
      sessionKv: env.SESSIONS,
      user: sessionUser(proposer.userId, ['proposer'], null),
      grantId: invite.grantId,
      now: NOW,
    });
    expect(secondAttempt.status).toBe(200);
    expect(await getSession(env.SESSIONS, token)).toBeNull();
  });
});

describe('handleWithdrawInvite', () => {
  it('deletes a pending invite only', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');

    const result = await handleWithdrawInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer'], null),
      grantId: invite.grantId,
    });
    expect(result.status).toBe(200);

    const grants = await getGrantsForProposer(db(), proposer.userId, { now: NOW });
    expect(grants.find((g) => g.id === invite.grantId)).toBeUndefined();
  });

  it('cannot withdraw an already-active grant', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');
    const coStakeAddr = `stake_test1-co-${nextId()}`;
    const coRow = await upsertUserFromAuth(db(), { stakeAddr: coStakeAddr, roles: [], now: NOW });
    await db()
      .prepare(`UPDATE proposer_grants SET status = 'active', co_user_id = ?1, co_stake_addr = ?2, redeemed_at = ?3 WHERE id = ?4`)
      .bind(coRow.id, coStakeAddr, NOW, invite.grantId)
      .run();

    const result = await handleWithdrawInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer'], null),
      grantId: invite.grantId,
    });
    expect(result.status).toBe(404);

    // Confirm the grant is still there, active, untouched.
    const stillActive = await withdrawInvite(db(), { grantId: invite.grantId, proposerUserId: proposer.userId });
    expect(stillActive).toBe(false);
  });

  it('403s for a grant session', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');

    const result = await handleWithdrawInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer'], 'some-grant-id'),
      grantId: invite.grantId,
    });
    expect(result.status).toBe(403);
  });
});
