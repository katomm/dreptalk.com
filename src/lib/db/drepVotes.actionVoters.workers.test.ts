// Workers test for getActionVoters + countActionVoters against a real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getActionVoters, countActionVoters, getActionSpoVoters, getActionVoterRank } from './drepVotes.js';

const GA_ID = 'ga-action-voters-test';

async function seed() {
  const db = env.DB;

  // Three DRep voters with distinct powers and votes.
  await db
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, synced_at)
       VALUES (?, 'DRep', 'drep-high', 'hex-high', 'Yes', 1)`,
    )
    .bind(GA_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, synced_at)
       VALUES (?, 'DRep', 'drep-low', 'hex-low', 'No', 1)`,
    )
    .bind(GA_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, synced_at)
       VALUES (?, 'DRep', 'drep-null', 'hex-null', 'Abstain', 1)`,
    )
    .bind(GA_ID)
    .run();

  // One SPO voter that must be excluded from results.
  await db
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, synced_at)
       VALUES (?, 'SPO', 'spo-should-be-excluded', null, 'Yes', 1)`,
    )
    .bind(GA_ID)
    .run();

  // Matching dreps rows: high power, low power, and NULL power.
  await db
    .prepare(
      `INSERT INTO dreps (drep_id, hex, has_script, status, active, voting_power, last_synced_at, created_at)
       VALUES ('drep-high', 'hex-high', 0, 'active', 1, '3000000000000', 1, 1)`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO dreps (drep_id, hex, has_script, status, active, voting_power, last_synced_at, created_at)
       VALUES ('drep-low', 'hex-low', 0, 'active', 1, '1000000000000', 1, 1)`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO dreps (drep_id, hex, has_script, status, active, voting_power, last_synced_at, created_at)
       VALUES ('drep-null', 'hex-null', 0, 'active', 1, NULL, 1, 1)`,
    )
    .run();
}

describe('getActionVoters', () => {
  it('returns exactly 3 DRep rows ordered by power desc, NULL power last', async () => {
    await seed();

    const rows = await getActionVoters(env.DB, GA_ID, { sort: 'power' });

    expect(rows).toHaveLength(3);

    // First row: highest power, Yes vote, hex joined.
    expect(rows[0].voter_id).toBe('drep-high');
    expect(rows[0].vote).toBe('Yes');
    expect(rows[0].voting_power).toBe('3000000000000');
    expect(rows[0].hex).toBe('hex-high');

    // Second row: lower power.
    expect(rows[1].voter_id).toBe('drep-low');
    expect(rows[1].vote).toBe('No');
    expect(rows[1].voting_power).toBe('1000000000000');

    // Third row: NULL power comes last.
    expect(rows[2].voter_id).toBe('drep-null');
    expect(rows[2].vote).toBe('Abstain');
    expect(rows[2].voting_power).toBeNull();
  });
});

describe('countActionVoters', () => {
  it('counts only DRep voters, excluding SPO', async () => {
    // seed() is idempotent via the unique (ga_id, voter_id) PK if already run above,
    // but each describe block gets a fresh DB in miniflare so seed again to be safe.
    await seed();
    expect(await countActionVoters(env.DB, GA_ID)).toBe(3);
  });
});

describe('getActionVoterRank', () => {
  it('agrees with the getActionVoters ordering for every DRep voter', async () => {
    await seed();
    const rows = await getActionVoters(env.DB, GA_ID, { sort: 'power' });
    for (const [i, row] of rows.entries()) {
      expect(await getActionVoterRank(env.DB, GA_ID, row.voter_id, 'DRep', 'power')).toBe(i);
    }
  });

  it('agrees with the getActionSpoVoters ordering for every SPO voter', async () => {
    const ga = 'ga-spo-rank-test';
    // Distinct block_times plus one NULL (sorted last), matching the SPO list order.
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, block_time, synced_at) VALUES
       (?, 'SPO', 'pool-old', null, 'Yes', 100, 1),
       (?, 'SPO', 'pool-new', null, 'No', 200, 1),
       (?, 'SPO', 'pool-untimed', null, 'Yes', NULL, 1)`,
    ).bind(ga, ga, ga).run();

    const rows = await getActionSpoVoters(env.DB, ga);
    expect(rows.map((r) => r.voter_id)).toEqual(['pool-new', 'pool-old', 'pool-untimed']);
    for (const [i, row] of rows.entries()) {
      // The SPO list has one order, whatever sort the page carries.
      expect(await getActionVoterRank(env.DB, ga, row.voter_id, 'SPO', 'power')).toBe(i);
      expect(await getActionVoterRank(env.DB, ga, row.voter_id, 'SPO', 'recent')).toBe(i);
    }
  });

  it('returns null for an unknown voter and for a role mismatch', async () => {
    await seed();
    expect(await getActionVoterRank(env.DB, GA_ID, 'drep-not-there', 'DRep', 'power')).toBeNull();
    // 'drep-high' voted as a DRep, so asking for its SPO rank finds nothing.
    expect(await getActionVoterRank(env.DB, GA_ID, 'drep-high', 'SPO', 'power')).toBeNull();
  });
});

describe('voter list sort', () => {
  const GA = 'ga-recent-sort-test';

  // Power order and time order differ on purpose. One vote is still pending
  // (cast here, not yet confirmed), one has no block time, one failed.
  async function seedSortCase() {
    const votes: Array<[string, number | null, string | null, string]> = [
      ['d-old-big', 100, null, '5000'],
      ['d-new-small', 300, null, '10'],
      ['d-mid', 200, null, '700'],
      ['d-pending', null, 'pending', '50'],
      ['d-untimed', null, null, '900'],
      ['d-failed', null, 'failed', '9999'],
    ];
    for (const [id, blockTime, localStatus, power] of votes) {
      await env.DB.prepare(
        `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, block_time, synced_at, local_status)
         VALUES (?, 'DRep', ?, NULL, 'Yes', ?, 1, ?)`,
      ).bind(GA, id, blockTime, localStatus).run();
      await env.DB.prepare(
        `INSERT INTO dreps (drep_id, hex, has_script, status, active, voting_power, last_synced_at, created_at)
         VALUES (?, ?, 0, 'active', 1, ?, 1, 1)`,
      ).bind(id, `hex-${id}`, power).run();
    }
  }

  it('orders by vote time under sort recent: pending first, untimed last, failed excluded', async () => {
    await seedSortCase();
    const rows = await getActionVoters(env.DB, GA, { sort: 'recent' });
    expect(rows.map((r) => r.voter_id)).toEqual(['d-pending', 'd-new-small', 'd-mid', 'd-old-big', 'd-untimed']);
    expect(rows[0].local_status).toBe('pending');
    expect(rows[1].local_status).toBeNull();
  });

  it('orders by voting power under sort power, unknown power last', async () => {
    await seedSortCase();
    const rows = await getActionVoters(env.DB, GA, { sort: 'power' });
    expect(rows.map((r) => r.voter_id)).toEqual(['d-old-big', 'd-untimed', 'd-mid', 'd-pending', 'd-new-small']);
  });

  it('rank agrees with the list under both sorts', async () => {
    await seedSortCase();
    for (const sort of ['recent', 'power'] as const) {
      const rows = await getActionVoters(env.DB, GA, { sort });
      expect(rows).toHaveLength(5);
      for (const [i, row] of rows.entries()) {
        expect(await getActionVoterRank(env.DB, GA, row.voter_id, 'DRep', sort)).toBe(i);
      }
    }
    expect(await getActionVoterRank(env.DB, GA, 'd-failed', 'DRep', 'recent')).toBeNull();
  });

  it('orders several pending votes by submission time, newest first', async () => {
    const ga = 'ga-recent-pending-test';
    // synced_at holds the submission second of a pending vote.
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, block_time, synced_at, local_status) VALUES
       (?, 'DRep', 'd-a-earlier', NULL, 'Yes', NULL, 1000, 'pending'),
       (?, 'DRep', 'd-z-later', NULL, 'No', NULL, 2000, 'pending'),
       (?, 'DRep', 'd-confirmed', NULL, 'Yes', 900, 5000, NULL)`,
    ).bind(ga, ga, ga).run();
    const rows = await getActionVoters(env.DB, ga, { sort: 'recent' });
    expect(rows.map((r) => r.voter_id)).toEqual(['d-z-later', 'd-a-earlier', 'd-confirmed']);
    for (const [i, row] of rows.entries()) {
      expect(await getActionVoterRank(env.DB, ga, row.voter_id, 'DRep', 'recent')).toBe(i);
    }
  });

  it('breaks equal block times by voter id', async () => {
    const ga = 'ga-recent-tie-test';
    await env.DB.prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, block_time, synced_at) VALUES
       (?, 'DRep', 'd-b', NULL, 'Yes', 500, 1),
       (?, 'DRep', 'd-a', NULL, 'No', 500, 1)`,
    ).bind(ga, ga).run();
    const rows = await getActionVoters(env.DB, ga, { sort: 'recent' });
    expect(rows.map((r) => r.voter_id)).toEqual(['d-a', 'd-b']);
  });
});
