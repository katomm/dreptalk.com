import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertVotes,
  getDrepVoteBreakdown,
  getDrepRationaleStats,
  getDrepParticipation,
} from './drepVotes.js';

async function seedAction(id: string, opts: { decidedEpoch: number | null; expiryEpoch: number | null }) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, expiry_epoch, decided_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, 'enacted', ?, ?, NULL, 0, 0)`,
  ).bind(id, id, opts.expiryEpoch, opts.decidedEpoch).run();
}

function vote(voterId: string, choice: string, metaUrl: string | null = null) {
  return [{ voterRole: 'DRep', voterId, voterHex: null, vote: choice, metaUrl }];
}

describe('getDrepVoteBreakdown', () => {
  it('counts yes/no/abstain by raw count', async () => {
    await seedAction('b1', { decidedEpoch: 500, expiryEpoch: 499 });
    await seedAction('b2', { decidedEpoch: 501, expiryEpoch: 500 });
    await seedAction('b3', { decidedEpoch: 502, expiryEpoch: 501 });
    await upsertVotes(env.DB, 'b1', vote('drepB', 'Yes'), 1);
    await upsertVotes(env.DB, 'b2', vote('drepB', 'Abstain'), 1);
    await upsertVotes(env.DB, 'b3', vote('drepB', 'Yes'), 1);

    expect(await getDrepVoteBreakdown(env.DB, 'drepB')).toEqual({ yes: 2, no: 0, abstain: 1, total: 3 });
  });
});

describe('getDrepRationaleStats', () => {
  it('counts votes with and without a rationale anchor (NULL or empty)', async () => {
    await seedAction('r1', { decidedEpoch: 500, expiryEpoch: 499 });
    await seedAction('r2', { decidedEpoch: 501, expiryEpoch: 500 });
    await seedAction('r3', { decidedEpoch: 502, expiryEpoch: 501 });
    await upsertVotes(env.DB, 'r1', vote('drepR', 'Yes', 'ipfs://x'), 1);
    await upsertVotes(env.DB, 'r2', vote('drepR', 'No', ''), 1);
    await upsertVotes(env.DB, 'r3', vote('drepR', 'No', null), 1);

    expect(await getDrepRationaleStats(env.DB, 'drepR')).toEqual({ total: 3, without: 2, withRationale: 1 });
  });

  it('is all-zero for a DRep with no votes', async () => {
    expect(await getDrepRationaleStats(env.DB, 'nobody')).toEqual({ total: 0, without: 0, withRationale: 0 });
  });
});
