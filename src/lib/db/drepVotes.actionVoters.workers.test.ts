// Workers test for getActionVoters + countActionVoters against a real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getActionVoters, countActionVoters } from './drepVotes.js';

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

    const rows = await getActionVoters(env.DB, GA_ID);

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
