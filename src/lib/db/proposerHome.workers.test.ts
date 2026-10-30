// /home data for proposers and co-proposers, runs in real workerd via @cloudflare/vitest-plugin.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listProposerActions, listMandates, loadProposerActionViews } from './proposerHome.js';
import { createGrantInvite, redeemGrant } from './proposerGrants.js';
import { upsertUserFromAuth } from './users.js';

const db = () => env.DB as D1Database;
const NOW = 1_700_000_000;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `${NOW}-${seq}`;
}

function actionId(fill: string, index = 0): string {
  return `${fill.repeat(64)}#${index}`;
}

async function insertAction(a: {
  id: string;
  returnAddress: string;
  status: string;
  title?: string | null;
  proposalId?: string | null;
  topicId?: string | null;
  submittedAt?: number | null;
  authors?: string[] | null;
}): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO governance_actions
         (id, proposal_id, type, title, status, return_address, topic_id, submitted_at, authors, created_at, last_synced_at)
       VALUES (?1, ?2, 'InfoAction', ?3, ?4, ?5, ?6, ?7, ?8, 1, 1)`,
    )
    .bind(
      a.id,
      a.proposalId ?? null,
      a.title ?? null,
      a.status,
      a.returnAddress,
      a.topicId ?? null,
      a.submittedAt ?? null,
      a.authors ? JSON.stringify(a.authors) : null,
    )
    .run();
}

async function insertTopic(id: string, slug: string): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, title, slug, last_post_at, created_at)
       VALUES (?1, 'governance', 'system', 't', ?2, 0, 0)`,
    )
    .bind(id, slug)
    .run();
}

describe('listProposerActions', () => {
  it('returns only the actions of the given return address', async () => {
    const mine = `stake_test1-mine-${nextId()}`;
    const other = `stake_test1-other-${nextId()}`;
    await insertAction({ id: actionId('1'), returnAddress: mine, status: 'active', title: 'Mine' });
    await insertAction({ id: actionId('2'), returnAddress: other, status: 'active', title: 'Theirs' });

    const rows = await listProposerActions(db(), mine);
    expect(rows.map((r) => r.id)).toEqual([actionId('1')]);
    expect(rows[0].title).toBe('Mine');
  });

  it('counts pending as open and a terminal status as finished, open first then newest', async () => {
    const addr = `stake_test1-groups-${nextId()}`;
    await insertAction({ id: actionId('3'), returnAddress: addr, status: 'enacted', submittedAt: 3_000 });
    await insertAction({ id: actionId('4'), returnAddress: addr, status: 'pending', submittedAt: 1_000 });
    await insertAction({ id: actionId('5'), returnAddress: addr, status: 'active', submittedAt: 2_000 });
    await insertAction({ id: actionId('6'), returnAddress: addr, status: 'expired', submittedAt: null });

    const rows = await listProposerActions(db(), addr);
    expect(rows.map((r) => [r.id, r.open])).toEqual([
      [actionId('5'), true],
      [actionId('4'), true],
      [actionId('3'), false],
      [actionId('6'), false],
    ]);
  });

  it('resolves the thread slug, the proposal id and the authors list', async () => {
    const addr = `stake_test1-slug-${nextId()}`;
    await insertTopic('topic-home-1', 'info-action-home-1');
    await insertAction({
      id: actionId('7'),
      returnAddress: addr,
      status: 'active',
      topicId: 'topic-home-1',
      proposalId: 'gov_action1home',
      authors: ['Trivolve Tech', 'Cardano Foundation'],
    });
    await insertAction({ id: actionId('8'), returnAddress: addr, status: 'active' });

    const rows = await listProposerActions(db(), addr);
    const withThread = rows.find((r) => r.id === actionId('7'))!;
    expect(withThread).toMatchObject({
      proposalId: 'gov_action1home',
      topicSlug: 'info-action-home-1',
      type: 'InfoAction',
      authors: ['Trivolve Tech', 'Cardano Foundation'],
    });
    const noThread = rows.find((r) => r.id === actionId('8'))!;
    expect(noThread.topicSlug).toBeNull();
    expect(noThread.authors).toEqual([]);
  });
});

describe('listMandates', () => {
  it('lists the active grants of a co-proposer with action title, thread and team', async () => {
    const proposerAddr = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';
    const proposer = await upsertUserFromAuth(db(), { stakeAddr: proposerAddr, roles: ['proposer'], now: NOW });
    const coAddr = `stake_test1-co-${nextId()}`;
    const co = await upsertUserFromAuth(db(), { stakeAddr: coAddr, roles: [], now: NOW });
    await insertTopic('topic-home-2', 'info-action-home-2');
    await insertAction({
      id: actionId('9'),
      returnAddress: proposerAddr,
      status: 'active',
      title: 'Project Alpha',
      topicId: 'topic-home-2',
    });

    const invite = await createGrantInvite(db(), {
      proposerUserId: proposer.id,
      proposerStakeAddr: proposerAddr,
      govActionId: actionId('9'),
      teamLabel: 'Trivolve Tech',
      now: NOW,
    });
    const redeemed = await redeemGrant(db(), {
      grantId: invite!.grantId,
      coUserId: co.id,
      coStakeAddr: coAddr,
      displayName: 'Ravi',
      now: NOW + 10,
    });
    expect(redeemed.ok).toBe(true);
    // A pending invite is no mandate yet.
    await createGrantInvite(db(), {
      proposerUserId: proposer.id,
      proposerStakeAddr: proposerAddr,
      govActionId: actionId('9'),
      teamLabel: null,
      now: NOW,
    });

    const mandates = await listMandates(db(), co.id);
    expect(mandates).toEqual([
      {
        grantId: invite!.grantId,
        actionId: actionId('9'),
        actionTitle: 'Project Alpha',
        actionType: 'InfoAction',
        topicSlug: 'info-action-home-2',
        proposerLabel: 'Intersect',
        teamLabel: 'Trivolve Tech',
        since: NOW + 10,
      },
    ]);
  });

  it('returns nothing for an account without grants', async () => {
    const lonely = await upsertUserFromAuth(db(), { stakeAddr: `stake_test1-none-${nextId()}`, roles: [], now: NOW });
    expect(await listMandates(db(), lonely.id)).toEqual([]);
  });
});

describe('loadProposerActionViews', () => {
  it('attaches pending invites and named active co-proposers to their action', async () => {
    const proposerAddr = `stake_test1-views-${nextId()}`;
    const proposer = await upsertUserFromAuth(db(), { stakeAddr: proposerAddr, roles: ['proposer'], now: NOW });
    const coAddr = `stake_test1-viewsco-${nextId()}`;
    const co = await upsertUserFromAuth(db(), { stakeAddr: coAddr, roles: [], now: NOW });
    await insertAction({ id: actionId('a'), returnAddress: proposerAddr, status: 'active', topicId: 'x' });
    await insertAction({ id: actionId('b'), returnAddress: proposerAddr, status: 'active' });

    // The loader reads with the real clock, so the invites are created against it too.
    const now = Math.floor(Date.now() / 1000);
    const base = { proposerUserId: proposer.id, proposerStakeAddr: proposerAddr, govActionId: actionId('a'), now };
    const redeemed = await createGrantInvite(db(), { ...base, teamLabel: 'Trivolve Tech' });
    await redeemGrant(db(), { grantId: redeemed!.grantId, coUserId: co.id, coStakeAddr: coAddr, displayName: 'Ravi', now: now + 5 });
    const pending = await createGrantInvite(db(), { ...base, teamLabel: null });

    const views = await loadProposerActionViews(db(), proposer.id, proposerAddr);
    const a = views.find((v) => v.id === actionId('a'))!;
    expect(a.active).toEqual([
      { grantId: redeemed!.grantId, coName: 'Ravi', coStakeAddr: expect.any(String), since: now + 5, teamLabel: 'Trivolve Tech' },
    ]);
    expect(a.pending.map((p) => p.grantId)).toEqual([pending!.grantId]);
    const b = views.find((v) => v.id === actionId('b'))!;
    expect(b.active).toEqual([]);
    expect(b.pending).toEqual([]);
  });
});
