import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listDecidedActionRationaleCoverage, countRationaleAddedViaRevote } from './rationaleCoverage.js';
import { upsertVotes } from './drepVotes.js';

async function seedAction(id: string, decided: number | null = 600) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, 'enacted', ?, NULL, 0, 0)`,
  ).bind(id, `T ${id}`, decided).run();
}

describe('listDecidedActionRationaleCoverage', () => {
  it('aggregates counts and TEXT power sums per decided action', async () => {
    await seedAction('ga_rc1#0');
    await seedAction('ga_rc_open#0', null);
    await upsertVotes(env.DB, 'ga_rc1#0', [
      { voterRole: 'DRep', voterId: 'drep_a', voterHex: null, vote: 'Yes', metaUrl: 'https://x/r.json', votedPower: 100 },
      { voterRole: 'DRep', voterId: 'drep_b', voterHex: null, vote: 'No', metaUrl: '', votedPower: 50 },
      { voterRole: 'DRep', voterId: 'drep_c', voterHex: null, vote: 'No', votedPower: 25 },
      { voterRole: 'SPO', voterId: 'pool_x', voterHex: null, vote: 'Yes', metaUrl: 'https://x/s.json', votedPower: 999 },
    ], 1);
    await upsertVotes(env.DB, 'ga_rc_open#0', [
      { voterRole: 'DRep', voterId: 'drep_a', voterHex: null, vote: 'Yes', votedPower: 1 },
    ], 1);
    const rows = await listDecidedActionRationaleCoverage(env.DB);
    const row = rows.find((r) => r.gaId === 'ga_rc1#0');
    expect(rows.some((r) => r.gaId === 'ga_rc_open#0')).toBe(false);
    expect(row).toMatchObject({ votes: 3, withRationale: 1, votesWithPower: 3 });
    expect(row?.power).toBe('175');
    expect(row?.powerWithRationale).toBe('100');
  });

  it('nulls the power sums when any vote lacks a power reading', async () => {
    await seedAction('ga_rc2#0');
    await upsertVotes(env.DB, 'ga_rc2#0', [
      { voterRole: 'DRep', voterId: 'drep_a', voterHex: null, vote: 'Yes', metaUrl: 'https://x/r.json', votedPower: 100 },
      { voterRole: 'DRep', voterId: 'drep_b', voterHex: null, vote: 'No' },
    ], 1);
    const rows = await listDecidedActionRationaleCoverage(env.DB);
    const row = rows.find((r) => r.gaId === 'ga_rc2#0');
    expect(row).toMatchObject({ votes: 2, withRationale: 1, votesWithPower: 1 });
    expect(row?.power).toBeNull();
    expect(row?.powerWithRationale).toBeNull();
  });
});

describe('countRationaleAddedViaRevote', () => {
  it('counts pairs whose earliest archived vote had no anchor and current has one', async () => {
    await seedAction('ga_rv1#0');
    // drep_a: first vote without anchor (archived), current with anchor -> counts.
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, meta_url, block_time, superseded_at) VALUES ('ga_rv1#0', 'drep_a', 'DRep', 'Yes', NULL, 10, 1)`,
    ).run();
    await upsertVotes(env.DB, 'ga_rv1#0', [
      { voterRole: 'DRep', voterId: 'drep_a', voterHex: null, vote: 'Yes', metaUrl: 'https://x/r.json' },
    ], 1);
    // drep_b: earliest archived vote HAD an anchor -> does not count even though a later archived one lacks it.
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, meta_url, block_time, superseded_at) VALUES ('ga_rv1#0', 'drep_b', 'DRep', 'Yes', 'https://x/old.json', 10, 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, meta_url, block_time, superseded_at) VALUES ('ga_rv1#0', 'drep_b', 'DRep', 'Yes', NULL, 20, 1)`,
    ).run();
    await upsertVotes(env.DB, 'ga_rv1#0', [
      { voterRole: 'DRep', voterId: 'drep_b', voterHex: null, vote: 'Yes', metaUrl: 'https://x/new.json' },
    ], 1);
    // drep_c: added an anchor on an OPEN action -> not counted (decided only).
    await seedAction('ga_rv_open#0', null);
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, meta_url, block_time, superseded_at) VALUES ('ga_rv_open#0', 'drep_c', 'DRep', 'Yes', NULL, 10, 1)`,
    ).run();
    await upsertVotes(env.DB, 'ga_rv_open#0', [
      { voterRole: 'DRep', voterId: 'drep_c', voterHex: null, vote: 'Yes', metaUrl: 'https://x/c.json' },
    ], 1);
    expect(await countRationaleAddedViaRevote(env.DB)).toBe(1);
  });
});
