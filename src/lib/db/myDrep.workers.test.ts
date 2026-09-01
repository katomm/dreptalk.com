import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  listDrepActionsSince,
  countVoteChangesSince,
  getPowerAtOrAfter,
  getPowerLatest,
  listRecentDecidedActions,
} from './myDrep.js';
import { upsertVotes } from './drepVotes.js';

async function seedAction(
  id: string,
  title: string | null,
  decidedEpoch: number | null,
  opts: { type?: string; status?: string; topicId?: string | null } = {},
) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, submitted_at, expiry_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, 0)`,
  )
    .bind(id, opts.type ?? 'InfoAction', title, opts.status ?? 'enacted', decidedEpoch, opts.topicId ?? null)
    .run();
}

async function seedTopic(id: string, slug: string) {
  await env.DB.prepare(
    `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
     VALUES (?, 'governance', 'gov-sync', 'governance', ?, ?, 1, 0, 0, 0)`,
  )
    .bind(id, `Title ${id}`, slug)
    .run();
}

async function seedVote(gaId: string, voterId: string, vote = 'Yes') {
  await upsertVotes(env.DB, gaId, [{ voterRole: 'DRep', voterId, voterHex: null, vote }], 1);
}

async function seedRationale(gaId: string, voterId: string, status: string) {
  await env.DB.prepare(
    `INSERT INTO action_rationale (ga_id, voter_id, body_html, source, anchor_url, status, attempts, created_at, fetched_at)
     VALUES (?, ?, NULL, 'onchain', NULL, ?, 1, 0, 0)`,
  )
    .bind(gaId, voterId, status)
    .run();
}

async function seedVoteHistory(
  gaId: string,
  voterId: string,
  blockTime: number,
  supersededAt: number,
  role = 'DRep',
) {
  await env.DB.prepare(
    `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, meta_url, meta_hash, block_time, body_html, superseded_at)
     VALUES (?, ?, ?, 'Yes', NULL, NULL, ?, NULL, ?)`,
  )
    .bind(gaId, voterId, role, blockTime, supersededAt)
    .run();
}

async function seedPower(drepId: string, epoch: number, amount: string, delegatorCount: number | null) {
  await env.DB.prepare(
    'INSERT INTO drep_voting_power_history (drep_id, epoch, amount, delegator_count) VALUES (?, ?, ?, ?)',
  )
    .bind(drepId, epoch, amount, delegatorCount)
    .run();
}

const DREP = 'drep1me';

describe('listDrepActionsSince', () => {
  it('mirrors the participation predicate: decided at or after the start, at least one DRep vote', async () => {
    // Decided before the delegation start: outside the window.
    await seedAction('ga_before', 'Before', 599);
    await seedVote('ga_before', 'drep1other');

    // In the window, our DRep voted.
    await seedTopic('t_a', 'topic-a');
    await seedAction('ga_voted', 'Voted action', 601, { topicId: 't_a', type: 'ParameterChange' });
    await seedVote('ga_voted', 'drep1other');
    await seedVote('ga_voted', DREP, 'No');

    // In the window, our DRep did not vote.
    await seedAction('ga_missed', 'Missed action', 602);
    await seedVote('ga_missed', 'drep1other');

    // In the window but no DRep vote at all: never DRep-votable.
    await seedAction('ga_novotes', 'No DRep votes', 603);

    // In the window, has a DRep vote, but dropped rows are not decisions.
    await seedAction('ga_dropped', 'Dropped', 604, { status: 'dropped' });
    await seedVote('ga_dropped', 'drep1other');

    // Still open: no decided epoch at all.
    await seedAction('ga_open', 'Open', null, { status: 'active' });
    await seedVote('ga_open', 'drep1other');

    const rows = await listDrepActionsSince(env.DB, DREP, 600);

    expect(rows.map((r) => r.gaId)).toEqual(['ga_missed', 'ga_voted']);
    expect(rows.filter((r) => r.vote != null).length).toBe(1);

    expect(rows[0]).toEqual({
      gaId: 'ga_missed',
      title: 'Missed action',
      topicSlug: null,
      type: 'InfoAction',
      decidedEpoch: 602,
      status: 'enacted',
      vote: null,
      hasRationale: false,
    });
    expect(rows[1]).toEqual({
      gaId: 'ga_voted',
      title: 'Voted action',
      topicSlug: 'topic-a',
      type: 'ParameterChange',
      decidedEpoch: 601,
      status: 'enacted',
      vote: 'No',
      hasRationale: false,
    });
  });

  it('reads the rationale flag from an action_rationale row with status ok', async () => {
    await seedAction('ga_ok', 'With rationale', 610);
    await seedVote('ga_ok', DREP);
    await seedRationale('ga_ok', DREP, 'ok');

    await seedAction('ga_empty', 'Empty rationale', 611);
    await seedVote('ga_empty', DREP);
    await seedRationale('ga_empty', DREP, 'empty');

    await seedAction('ga_failed', 'Failed rationale', 612);
    await seedVote('ga_failed', DREP);
    await seedRationale('ga_failed', DREP, 'failed');

    await seedAction('ga_none', 'No rationale row', 613);
    await seedVote('ga_none', DREP);

    // Somebody else's rationale on the same action must not count as ours.
    await seedAction('ga_other', 'Other voter rationale', 614);
    await seedVote('ga_other', DREP);
    await seedVote('ga_other', 'drep1other');
    await seedRationale('ga_other', 'drep1other', 'ok');

    const rows = await listDrepActionsSince(env.DB, DREP, 600);
    const flags = new Map(rows.map((r) => [r.gaId, r.hasRationale]));

    expect(flags.get('ga_ok')).toBe(true);
    expect(flags.get('ga_empty')).toBe(false);
    expect(flags.get('ga_failed')).toBe(false);
    expect(flags.get('ga_none')).toBe(false);
    expect(flags.get('ga_other')).toBe(false);
  });

  it('breaks a decided-epoch tie on the action id ascending', async () => {
    await seedAction('ga_c', 'C', 620);
    await seedVote('ga_c', 'drep1other');
    await seedAction('ga_a', 'A', 620);
    await seedVote('ga_a', 'drep1other');
    await seedAction('ga_b', 'B', 621);
    await seedVote('ga_b', 'drep1other');

    const rows = await listDrepActionsSince(env.DB, DREP, 600);
    expect(rows.map((r) => r.gaId)).toEqual(['ga_b', 'ga_a', 'ga_c']);
  });

  it('ignores a locally failed vote, so a never-confirmed self-cast reads as missed', async () => {
    await seedAction('ga_failedvote', 'Failed self cast', 630);
    await seedVote('ga_failedvote', 'drep1other');
    await seedVote('ga_failedvote', DREP);
    await env.DB.prepare("UPDATE drep_votes SET local_status = 'failed' WHERE ga_id = ? AND voter_id = ?")
      .bind('ga_failedvote', DREP)
      .run();

    const rows = await listDrepActionsSince(env.DB, DREP, 600);
    expect(rows).toHaveLength(1);
    expect(rows[0].vote).toBeNull();
  });

  it('returns an empty list when nothing was decided in the window', async () => {
    await seedAction('ga_before', 'Before', 500);
    await seedVote('ga_before', 'drep1other');
    expect(await listDrepActionsSince(env.DB, DREP, 600)).toEqual([]);
  });
});

describe('countVoteChangesSince', () => {
  it('counts the DReps own superseded votes from sinceUnix inclusive', async () => {
    const since = 1_700_000_000;
    await seedVoteHistory('ga_1', DREP, since - 100, since - 1);
    await seedVoteHistory('ga_2', DREP, since - 100, since);
    await seedVoteHistory('ga_3', DREP, since - 100, since + 1);
    // Another voter, and our own id in the SPO role: neither counts.
    await seedVoteHistory('ga_4', 'drep1other', since - 100, since + 1);
    await seedVoteHistory('ga_5', DREP, since - 100, since + 1, 'SPO');

    expect(await countVoteChangesSince(env.DB, DREP, since)).toBe(2);
  });

  it('keys the window on when the vote was replaced, not on when it was cast', async () => {
    const since = 1_700_000_000;
    // Cast well before the delegation started, replaced inside the window: counts,
    // because the delegator lived through that change.
    await seedVoteHistory('ga_old_new', DREP, since - 500_000, since + 10);
    // Cast inside the window but already replaced before it started: impossible on
    // real data, and the row must follow superseded_at either way.
    await seedVoteHistory('ga_new_old', DREP, since + 10, since - 10);
    // Cast and replaced entirely before the window.
    await seedVoteHistory('ga_both_old', DREP, since - 500_000, since - 1);

    expect(await countVoteChangesSince(env.DB, DREP, since)).toBe(1);
  });

  it('is 0 without any history rows', async () => {
    expect(await countVoteChangesSince(env.DB, DREP, 1_700_000_000)).toBe(0);
  });
});

describe('getPowerAtOrAfter and getPowerLatest', () => {
  it('picks the earliest snapshot at or after the epoch, and the latest one overall', async () => {
    await seedPower(DREP, 600, '1000000000', 12);
    await seedPower(DREP, 610, '2000000000', null);
    await seedPower(DREP, 620, '3000000000', 30);
    await seedPower('drep1other', 615, '9000000000', 99);

    expect(await getPowerAtOrAfter(env.DB, DREP, 600)).toEqual({ epoch: 600, amount: '1000000000', delegatorCount: 12 });
    expect(await getPowerAtOrAfter(env.DB, DREP, 605)).toEqual({ epoch: 610, amount: '2000000000', delegatorCount: null });
    expect(await getPowerAtOrAfter(env.DB, DREP, 621)).toBeNull();
    expect(await getPowerLatest(env.DB, DREP)).toEqual({ epoch: 620, amount: '3000000000', delegatorCount: 30 });
  });

  it('returns null for a DRep with no snapshots at all', async () => {
    expect(await getPowerAtOrAfter(env.DB, DREP, 600)).toBeNull();
    expect(await getPowerLatest(env.DB, DREP)).toBeNull();
  });
});

describe('listRecentDecidedActions', () => {
  it('returns decided actions newest first, capped by the limit, dropped rows excluded', async () => {
    await seedTopic('t_r', 'topic-r');
    await seedAction('ga_r1', 'R1', 700, { topicId: 't_r' });
    await seedAction('ga_r2', 'R2', 701, { status: 'expired' });
    await seedAction('ga_r3', 'R3', 702, { status: 'closed', type: 'InfoAction' });
    await seedAction('ga_r4', 'R4', 703, { status: 'dropped' });
    await seedAction('ga_r5', 'R5', null, { status: 'active' });

    const rows = await listRecentDecidedActions(env.DB, 2);
    expect(rows.map((r) => r.gaId)).toEqual(['ga_r3', 'ga_r2']);
    expect(rows[0]).toEqual({
      gaId: 'ga_r3',
      title: 'R3',
      topicSlug: null,
      type: 'InfoAction',
      status: 'closed',
      decidedEpoch: 702,
    });

    const all = await listRecentDecidedActions(env.DB, 10);
    expect(all.map((r) => r.gaId)).toEqual(['ga_r3', 'ga_r2', 'ga_r1']);
    expect(all[2].topicSlug).toBe('topic-r');
  });

  it('breaks a decided-epoch tie on the action id ascending', async () => {
    await seedAction('ga_z', 'Z', 700);
    await seedAction('ga_y', 'Y', 700);
    const rows = await listRecentDecidedActions(env.DB, 10);
    expect(rows.map((r) => r.gaId)).toEqual(['ga_y', 'ga_z']);
  });
});
