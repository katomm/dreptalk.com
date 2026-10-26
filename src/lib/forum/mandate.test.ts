import { describe, it, expect } from 'vitest';
import { loadMandates } from './mandate.js';
import type { GrantWithTopic, ProposerGrant } from '../db/proposerGrants.js';

// Real curated address (config/proposers.ts) so the "known" branch exercises
// the actual registry, the same way the brief's example label does.
const INTERSECT_ADDR = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';

const CF_ADDR = 'stake1uyveryunknownlongaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function grant(
  id: string,
  addr: string,
  status: ProposerGrant['status'] = 'active',
  teamLabel: string | null = null,
): GrantWithTopic {
  return {
    id,
    proposer_user_id: 'proposer-user',
    proposer_stake_addr: addr,
    gov_action_id: `${'a'.repeat(64)}#0`,
    team_label: teamLabel,
    co_user_id: 'co-user',
    co_stake_addr: 'stake1co',
    status,
    created_at: 0,
    expires_at: 0,
    redeemed_at: 0,
    revoked_at: status === 'revoked' ? 1 : null,
    // The thread of the grant's action.
    topic_id: 'topic-x',
  };
}

// A stand-in for getGrantsByIds so the mapping/label logic is testable without
// touching D1, the same way proposer.test.ts injects proposerView's lookup.
function fakeFetch(grants: GrantWithTopic[]) {
  const byId = new Map(grants.map((g) => [g.id, g]));
  const calls: (readonly string[])[] = [];
  const fetch = async (_db: unknown, ids: readonly string[]) => {
    calls.push(ids);
    const out = new Map<string, GrantWithTopic>();
    for (const id of ids) {
      const g = byId.get(id);
      if (g) out.set(id, g);
    }
    return out;
  };
  return { fetch, calls };
}

describe('loadMandates badge', () => {
  it('reads "Proposer team · <team>" in the thread of the grant action, with the submitter tooltip', async () => {
    const { fetch } = fakeFetch([grant('g1', INTERSECT_ADDR, 'active', 'Trivolve Tech')]);
    const map = await loadMandates(undefined as never, ['g1'], 'topic-x', fetch as never);
    expect(map.get('g1')).toEqual({
      label: 'Proposer team · Trivolve Tech',
      title: 'Invited by Intersect, which submitted this action',
    });
  });

  it('reads plain "Proposer team" without a team label', async () => {
    const { fetch } = fakeFetch([grant('g1', CF_ADDR)]);
    const map = await loadMandates(undefined as never, ['g1'], 'topic-x', fetch as never);
    expect(map.get('g1')?.label).toBe('Proposer team');
    expect(map.get('g1')?.title).toContain('Invited by stake1');
  });

  it('keeps "for <Proposer>" with a null title in another topic (Proposal Drafts)', async () => {
    const { fetch } = fakeFetch([grant('g1', INTERSECT_ADDR, 'active', 'Trivolve Tech')]);
    const map = await loadMandates(undefined as never, ['g1'], 'draft-topic', fetch as never);
    expect(map.get('g1')).toEqual({ label: 'for Intersect', title: null });
  });

  it('uses the "for" badge when no topic is rendered (category list)', async () => {
    const { fetch } = fakeFetch([grant('g1', INTERSECT_ADDR, 'active', 'Trivolve Tech')]);
    const map = await loadMandates(undefined as never, ['g1'], null, fetch as never);
    expect(map.get('g1')).toEqual({ label: 'for Intersect', title: null });
  });

  it('renders a revoked grant like an active one in the action thread', async () => {
    const { fetch } = fakeFetch([grant('g1', INTERSECT_ADDR, 'revoked', 'Trivolve Tech')]);
    const map = await loadMandates(undefined as never, ['g1'], 'topic-x', fetch as never);
    expect(map.get('g1')?.label).toBe('Proposer team · Trivolve Tech');
  });
});

describe('loadMandates', () => {
  it('labels a curated proposer "for Intersect"', async () => {
    const { fetch } = fakeFetch([grant('g1', INTERSECT_ADDR)]);
    const map = await loadMandates(undefined as never, ['g1'], null, fetch as never);
    expect(map.get('g1')?.label).toBe('for Intersect');
  });

  it('falls back to "for <truncated address>" for unknown addresses', async () => {
    const addr = 'stake1uyveryunknownlongaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const { fetch } = fakeFetch([grant('g1', addr)]);
    const map = await loadMandates(undefined as never, ['g1'], null, fetch as never);
    const label = map.get('g1')?.label;
    expect(label).toBeDefined();
    expect(label!.startsWith('for ')).toBe(true);
    expect(label).toContain('...');
    expect(label).not.toContain(addr); // truncated, not the full address
  });

  it('resolves revoked grants the same as active ones (historical attribution)', async () => {
    const { fetch } = fakeFetch([grant('g1', INTERSECT_ADDR, 'revoked')]);
    const map = await loadMandates(undefined as never, ['g1'], null, fetch as never);
    expect(map.get('g1')?.label).toBe('for Intersect');
  });

  it('dedupes ids and skips null/undefined', async () => {
    const { fetch, calls } = fakeFetch([grant('g1', INTERSECT_ADDR)]);
    const map = await loadMandates(undefined as never, ['g1', 'g1', null, undefined, 'g1'], null, fetch as never);
    expect(map.size).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['g1']);
  });

  it('returns an empty map without calling the fetch on an empty/nullish-only id list', async () => {
    const { fetch, calls } = fakeFetch([]);
    const empty = await loadMandates(undefined as never, [], null, fetch as never);
    expect(empty.size).toBe(0);
    const nullish = await loadMandates(undefined as never, [null, undefined], null, fetch as never);
    expect(nullish.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
