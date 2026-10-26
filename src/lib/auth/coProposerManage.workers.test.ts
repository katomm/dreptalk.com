// Workers-runtime tests for the proposer-facing co-proposer management
// handlers: create invite, revoke an active grant, withdraw a pending one.
// Runs in real workerd via @cloudflare/vitest-pool-workers, using the real
// D1/KV bindings, mirroring coProposerRedeem.workers.test.ts's setup.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleCreateInvite, handleRevokeGrant, handleWithdrawInvite } from './coProposerManage.js';
import { createGrantInvite, getGrantsForProposerActions, withdrawInvite } from '../db/proposerGrants.js';
import { upsertUserFromAuth } from '../db/users.js';

const db = () => env.DB as D1Database;
const NOW = 1_700_000_000;
const ACTION = `${'a'.repeat(64)}#0`;

async function getGrantsForProposer(d: D1Database, proposerUserId: string, opts: { now: number }) {
  return [...(await getGrantsForProposerActions(d, proposerUserId, opts)).values()].flat();
}

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

async function seedAction(o: {
  id?: string;
  returnAddress: string | null;
  status?: string;
  topicId?: string | null;
  authors?: string[] | null;
  title?: string | null;
}): Promise<string> {
  const id = o.id ?? ACTION;
  await db()
    .prepare(
      `INSERT OR REPLACE INTO governance_actions (id, type, title, status, return_address, topic_id, authors, created_at, last_synced_at)
       VALUES (?1, 'InfoAction', ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    )
    .bind(
      id,
      o.title === undefined ? 'An action' : o.title,
      o.status ?? 'active',
      o.returnAddress,
      o.topicId === undefined ? 'topic-1' : o.topicId,
      o.authors ? JSON.stringify(o.authors) : null,
      NOW,
    )
    .run();
  return id;
}

/** A proposer who owns an open action with a thread. */
async function makeProposerWithAction(o?: Partial<Parameters<typeof seedAction>[0]>) {
  const proposer = await makeProposer();
  const id = await seedAction({ returnAddress: proposer.stakeAddr, ...o });
  return { ...proposer, actionId: id };
}

async function teamLabelFor(proposerUserId: string): Promise<string | null | undefined> {
  const row = await db()
    .prepare('SELECT team_label FROM proposer_grants WHERE proposer_user_id = ?1')
    .bind(proposerUserId)
    .first<{ team_label: string | null }>();
  return row ? row.team_label : undefined;
}

/** A session-shaped user object, the same fields coProposerManage reads off locals.user. */
function sessionUser(id: string, roles: string[]) {
  return { id, roles };
}

describe('handleCreateInvite: guard enforcement', () => {
  it('403s for a co-proposer session without the proposer role', async () => {
    const proposer = await makeProposer();
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['co-proposer']),
      govActionId: ACTION,
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
      user: sessionUser(proposer.userId, ['member']),
      govActionId: ACTION,
      now: NOW,
    });
    expect(result.status).toBe(403);
  });

  it('403s for a proposer-role session whose row is not actually a proposer', async () => {
    const member = await makeMember();
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(member.userId, ['proposer']),
      govActionId: ACTION,
      now: NOW,
    });
    expect(result.status).toBe(403);
  });

  it('200s with an invite url for a real proposer session + row', async () => {
    const proposer = await makeProposerWithAction();
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer']),
      govActionId: proposer.actionId,
      now: NOW,
    });
    expect(result.status).toBe(200);
    const json = result.json as { inviteUrl: string; expiresAt: number };
    expect(json.inviteUrl).toMatch(/^\/co-proposer\/redeem\?code=/);
    expect(json.expiresAt).toBeGreaterThan(NOW);
    expect(await teamLabelFor(proposer.userId)).toBeNull();
  });

  it('409s at the 4-grant limit per action', async () => {
    const proposer = await makeProposerWithAction();
    const user = sessionUser(proposer.userId, ['proposer']);
    for (let i = 0; i < 4; i++) {
      const ok = await handleCreateInvite({ db: db(), user, govActionId: proposer.actionId, now: NOW });
      expect(ok.status).toBe(200);
    }

    const fifth = await handleCreateInvite({ db: db(), user, govActionId: proposer.actionId, now: NOW });
    expect(fifth.status).toBe(409);
    expect((fifth.json as { error: string }).error).toBe('limit reached');
  });

  it('400s for a missing or malformed action id', async () => {
    const proposer = await makeProposerWithAction();
    const user = sessionUser(proposer.userId, ['proposer']);
    for (const bad of [undefined, '', 42, 'not-an-id', 'gov_action1abc']) {
      const r = await handleCreateInvite({ db: db(), user, govActionId: bad, now: NOW });
      expect(r.status).toBe(400);
    }
  });

  it('403s for an action returned to another address, or one that does not exist', async () => {
    const proposer = await makeProposer();
    const foreign = await seedAction({ id: `${'b'.repeat(64)}#0`, returnAddress: 'stake_test1-someone-else' });
    const user = sessionUser(proposer.userId, ['proposer']);
    expect((await handleCreateInvite({ db: db(), user, govActionId: foreign, now: NOW })).status).toBe(403);
    const missing = await handleCreateInvite({ db: db(), user, govActionId: `${'c'.repeat(64)}#0`, now: NOW });
    expect(missing.status).toBe(403);
  });

  it('409s action finished for a terminal status, but not for pending', async () => {
    const done = await makeProposerWithAction({ status: 'enacted' });
    const r = await handleCreateInvite({ db: db(), user: sessionUser(done.userId, ['proposer']), govActionId: done.actionId, now: NOW });
    expect(r.status).toBe(409);
    expect((r.json as { error: string }).error).toBe('action finished');

    const fresh = await makeProposerWithAction({ id: `${'d'.repeat(64)}#0`, status: 'pending' });
    const ok = await handleCreateInvite({ db: db(), user: sessionUser(fresh.userId, ['proposer']), govActionId: fresh.actionId, now: NOW });
    expect(ok.status).toBe(200);
  });

  it('409s no thread yet when the action has no topic', async () => {
    const p = await makeProposerWithAction({ topicId: null });
    const r = await handleCreateInvite({ db: db(), user: sessionUser(p.userId, ['proposer']), govActionId: p.actionId, now: NOW });
    expect(r.status).toBe(409);
    expect((r.json as { error: string }).error).toBe('no thread yet');
  });

  it('500s when proposer row lacks a stake address', async () => {
    const proposer = await makeProposer();
    // Clear the stake_addr to simulate a malformed row that lacks the proposer identity.
    await db().prepare('UPDATE users SET stake_addr = NULL WHERE id = ?1').bind(proposer.userId).run();
    const result = await handleCreateInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer']),
      govActionId: ACTION,
      now: NOW,
    });
    expect(result.status).toBe(500);
    expect((result.json as { error: string }).error).toBe('internal error');

    // Verify no grant row was created.
    const grants = await getGrantsForProposer(db(), proposer.userId, { now: NOW });
    expect(grants).toHaveLength(0);
  });
});

describe('handleCreateInvite: team name', () => {
  const AUTHORS = ['Trivolve Tech', 'Cardano Foundation'];

  it('stores a team name that is one of the action authors', async () => {
    const p = await makeProposerWithAction({ authors: AUTHORS });
    const r = await handleCreateInvite({
      db: db(),
      user: sessionUser(p.userId, ['proposer']),
      govActionId: p.actionId,
      teamLabel: '  Trivolve Tech ',
      now: NOW,
    });
    expect(r.status).toBe(200);
    expect(await teamLabelFor(p.userId)).toBe('Trivolve Tech');
  });

  it('400s unknown team for a name outside the authors, or when there are no authors', async () => {
    const p = await makeProposerWithAction({ authors: AUTHORS });
    const user = sessionUser(p.userId, ['proposer']);
    for (const bad of ['Someone Else', 'trivolve tech', 7]) {
      const r = await handleCreateInvite({ db: db(), user, govActionId: p.actionId, teamLabel: bad, now: NOW });
      expect(r.status).toBe(400);
      expect((r.json as { error: string }).error).toBe('unknown team');
    }
    const none = await makeProposerWithAction({ id: `${'e'.repeat(64)}#0`, authors: null });
    const r = await handleCreateInvite({
      db: db(),
      user: sessionUser(none.userId, ['proposer']),
      govActionId: none.actionId,
      teamLabel: 'Trivolve Tech',
      now: NOW,
    });
    expect(r.status).toBe(400);
  });

  it('treats absent, empty and whitespace team names as no team', async () => {
    for (const [i, label] of [undefined, '', '   '].entries()) {
      const p = await makeProposerWithAction({ id: `${String(i).repeat(64)}#0`, authors: AUTHORS });
      const r = await handleCreateInvite({
        db: db(),
        user: sessionUser(p.userId, ['proposer']),
        govActionId: p.actionId,
        teamLabel: label,
        now: NOW,
      });
      expect(r.status).toBe(200);
      expect(await teamLabelFor(p.userId)).toBeNull();
    }
  });
});

describe('handleRevokeGrant', () => {
  it('revokes only for the owning proposer; pending grants cannot be revoked, only withdrawn', async () => {
    const proposer = await makeProposer();
    const otherProposer = await makeProposer();

    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, govActionId: ACTION, teamLabel: null, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');

    // A pending (never redeemed) grant cannot be revoked.
    const pendingAttempt = await handleRevokeGrant({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer']),
      grantId: invite.grantId,
      now: NOW,
    });
    expect(pendingAttempt.status).toBe(404);

    // Redeem it so it becomes active.
    const coStakeAddr = `stake_test1-co-${nextId()}`;
    const coRow = await upsertUserFromAuth(db(), { stakeAddr: coStakeAddr, roles: [], now: NOW });
    await db()
      .prepare(`UPDATE proposer_grants SET status = 'active', co_user_id = ?1, co_stake_addr = ?2, redeemed_at = ?3 WHERE id = ?4`)
      .bind(coRow.id, coStakeAddr, NOW, invite.grantId)
      .run();

    // A different real proposer cannot revoke someone else's grant.
    const wrongOwner = await handleRevokeGrant({
      db: db(),
      user: sessionUser(otherProposer.userId, ['proposer']),
      grantId: invite.grantId,
      now: NOW,
    });
    expect(wrongOwner.status).toBe(404);

    // The owning proposer can revoke it.
    const result = await handleRevokeGrant({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer']),
      grantId: invite.grantId,
      now: NOW,
    });
    expect(result.status).toBe(200);

    const grants = await getGrantsForProposer(db(), proposer.userId, { now: NOW });
    expect(grants.find((g) => g.id === invite.grantId)).toBeUndefined();
  });
});

describe('handleWithdrawInvite', () => {
  it('deletes a pending invite only', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, govActionId: ACTION, teamLabel: null, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');

    const result = await handleWithdrawInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer']),
      grantId: invite.grantId,
    });
    expect(result.status).toBe(200);

    const grants = await getGrantsForProposer(db(), proposer.userId, { now: NOW });
    expect(grants.find((g) => g.id === invite.grantId)).toBeUndefined();
  });

  it('cannot withdraw an already-active grant', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, govActionId: ACTION, teamLabel: null, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');
    const coStakeAddr = `stake_test1-co-${nextId()}`;
    const coRow = await upsertUserFromAuth(db(), { stakeAddr: coStakeAddr, roles: [], now: NOW });
    await db()
      .prepare(`UPDATE proposer_grants SET status = 'active', co_user_id = ?1, co_stake_addr = ?2, redeemed_at = ?3 WHERE id = ?4`)
      .bind(coRow.id, coStakeAddr, NOW, invite.grantId)
      .run();

    const result = await handleWithdrawInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['proposer']),
      grantId: invite.grantId,
    });
    expect(result.status).toBe(404);

    // Confirm the grant is still there, active, untouched.
    const stillActive = await withdrawInvite(db(), { grantId: invite.grantId, proposerUserId: proposer.userId });
    expect(stillActive).toBe(false);
  });

  it('403s for a co-proposer session', async () => {
    const proposer = await makeProposer();
    const invite = await createGrantInvite(db(), { proposerUserId: proposer.userId, proposerStakeAddr: proposer.stakeAddr, govActionId: ACTION, teamLabel: null, now: NOW });
    if (!invite) throw new Error('createGrantInvite returned null');

    const result = await handleWithdrawInvite({
      db: db(),
      user: sessionUser(proposer.userId, ['co-proposer']),
      grantId: invite.grantId,
    });
    expect(result.status).toBe(403);
  });
});
