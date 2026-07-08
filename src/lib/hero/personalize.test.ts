import { describe, expect, it } from 'vitest';
import { orderVoteCandidates } from './personalize';
import type { DrepVoteHistoryRow } from '../db/drepVotes.js';

function hist(partial: Partial<DrepVoteHistoryRow>): DrepVoteHistoryRow {
  return {
    ga_id: 'ga',
    vote: 'Yes',
    title: 'A proposal',
    type: 'InfoAction',
    status: 'expired',
    decided_epoch: 500,
    topic_slug: 'a-proposal',
    meta_url: null,
    block_time: 1000,
    rationale_html: null,
    ...partial,
  };
}

describe('orderVoteCandidates', () => {
  it('drops rows without a title or topic slug', () => {
    const out = orderVoteCandidates([
      hist({ ga_id: 'ok' }),
      hist({ ga_id: 'no-title', title: null }),
      hist({ ga_id: 'no-slug', topic_slug: null }),
    ]);
    expect(out.map((r) => r.ga_id)).toEqual(['ok']);
  });

  it('orders active actions before concluded ones', () => {
    const out = orderVoteCandidates([
      hist({ ga_id: 'old-decided', status: 'enacted', block_time: 900 }),
      hist({ ga_id: 'active-a', status: 'active', block_time: 500 }),
    ]);
    expect(out.map((r) => r.ga_id)).toEqual(['active-a', 'old-decided']);
  });

  it('orders each group by most recent vote first, null block_time last', () => {
    const out = orderVoteCandidates([
      hist({ ga_id: 'a1', status: 'active', block_time: 100 }),
      hist({ ga_id: 'a2', status: 'active', block_time: 300 }),
      hist({ ga_id: 'a3', status: 'active', block_time: null }),
    ]);
    expect(out.map((r) => r.ga_id)).toEqual(['a2', 'a1', 'a3']);
  });

  it('does not mutate its input', () => {
    const input = [hist({ ga_id: 'x', status: 'active' }), hist({ ga_id: 'y' })];
    const snapshot = input.map((r) => r.ga_id);
    orderVoteCandidates(input);
    expect(input.map((r) => r.ga_id)).toEqual(snapshot);
  });
});
