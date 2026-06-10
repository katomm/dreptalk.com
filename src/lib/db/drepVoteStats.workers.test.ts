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
