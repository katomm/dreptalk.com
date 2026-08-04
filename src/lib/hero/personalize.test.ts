import { describe, expect, it } from 'vitest';
import { orderVoteCandidates, buildPersonalizedRing } from './personalize';
import type { DrepVoteHistoryRow, ActionVoterRow } from '../db/drepVotes.js';

function hist(partial: Partial<DrepVoteHistoryRow>): DrepVoteHistoryRow {
  return {
    ga_id: 'ga',
    vote: 'Yes',
    title: 'A proposal',
    type: 'InfoAction',
    status: 'expired',
    decided_epoch: 500,
    submitted_epoch: 493,
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

function voter(id: string): ActionVoterRow {
  return { voter_id: id, vote: 'Yes', voting_power: '1000', hex: null, voter_hex: null, image_url: null, block_time: 1000 };
}

describe('buildPersonalizedRing', () => {
  it('pins an already-present viewer to the first active slot without duplication', () => {
    const voters = [voter('vp-strong'), voter('me'), voter('vp-weak')];
    const ring = buildPersonalizedRing({ voters, viewerDrepId: 'me', viewerVote: 'No', maxActive: 10, maxGhosts: 8 });
    expect(ring.selfIndex).toBe(0);
    expect(ring.active[0].voter_id).toBe('me');
    expect(ring.active.filter((v) => v.voter_id === 'me')).toHaveLength(1);
    expect(ring.active.map((v) => v.voter_id)).toEqual(['me', 'vp-strong', 'vp-weak']);
  });

  it('synthesizes a self row when the viewer is outside the fetched voters', () => {
    const voters = [voter('a'), voter('b'), voter('c')];
    const ring = buildPersonalizedRing({ voters, viewerDrepId: 'me', viewerVote: 'Abstain', maxActive: 10, maxGhosts: 8 });
    expect(ring.selfIndex).toBe(0);
    expect(ring.active[0]).toMatchObject({ voter_id: 'me', vote: 'Abstain', voting_power: null });
    expect(ring.active.map((v) => v.voter_id)).toEqual(['me', 'a', 'b', 'c']);
  });

  it('caps the active ring, overflows into ghosts, and never puts self in ghosts', () => {
    const voters = Array.from({ length: 20 }, (_, i) => voter(`v${i}`));
    const ring = buildPersonalizedRing({ voters, viewerDrepId: 'me', viewerVote: 'Yes', maxActive: 10, maxGhosts: 8 });
    expect(ring.active).toHaveLength(10);
    expect(ring.active[0].voter_id).toBe('me');
    expect(ring.ghosts).toHaveLength(8);
    expect(ring.ghosts.some((v) => v.voter_id === 'me')).toBe(false);
    expect(ring.active.slice(1).map((v) => v.voter_id)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']);
    expect(ring.ghosts.map((v) => v.voter_id)).toEqual(['v9', 'v10', 'v11', 'v12', 'v13', 'v14', 'v15', 'v16']);
  });
});
