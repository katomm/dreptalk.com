import { describe, it, expect } from 'vitest';
import { loadMandates } from './mandate.js';
import type { ProposerGrant } from '../db/proposerGrants.js';

// Real curated address (config/proposers.ts) so the "known" branch exercises
// the actual registry, the same way the brief's example label does.
const INTERSECT_ADDR = 'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp';

function grant(id: string, addr: string, status: ProposerGrant['status'] = 'active'): ProposerGrant {
  return {
    id,
    proposer_user_id: 'proposer-user',
    proposer_stake_addr: addr,
    co_user_id: 'co-user',
    co_stake_addr: 'stake1co',
    status,
    created_at: 0,
    expires_at: 0,
    redeemed_at: 0,
    revoked_at: status === 'revoked' ? 1 : null,
  };
}

// A stand-in for getGrantsByIds so the mapping/label logic is testable without
// touching D1, the same way proposer.test.ts injects proposerView's lookup.
function fakeFetch(grants: ProposerGrant[]) {
  const byId = new Map(grants.map((g) => [g.id, g]));
  const calls: (readonly string[])[] = [];
  const fetch = async (_db: unknown, ids: readonly string[]) => {
    calls.push(ids);
    const out = new Map<string, ProposerGrant>();
    for (const id of ids) {
      const g = byId.get(id);
      if (g) out.set(id, g);
    }
    return out;
  };
  return { fetch, calls };
}

describe('loadMandates', () => {
  it('labels a curated proposer "for Intersect"', async () => {
    const { fetch } = fakeFetch([grant('g1', INTERSECT_ADDR)]);
    const map = await loadMandates(undefined as never, ['g1'], fetch as never);
    expect(map.get('g1')).toBe('for Intersect');
  });

  it('falls back to "for <truncated address>" for unknown addresses', async () => {
    const addr = 'stake1uyveryunknownlongaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const { fetch } = fakeFetch([grant('g1', addr)]);
    const map = await loadMandates(undefined as never, ['g1'], fetch as never);
    const label = map.get('g1');
    expect(label).toBeDefined();
    expect(label!.startsWith('for ')).toBe(true);
    expect(label).toContain('...');
    expect(label).not.toContain(addr); // truncated, not the full address
  });

  it('resolves revoked grants the same as active ones (historical attribution)', async () => {
    const { fetch } = fakeFetch([grant('g1', INTERSECT_ADDR, 'revoked')]);
    const map = await loadMandates(undefined as never, ['g1'], fetch as never);
    expect(map.get('g1')).toBe('for Intersect');
  });

  it('dedupes ids and skips null/undefined', async () => {
    const { fetch, calls } = fakeFetch([grant('g1', INTERSECT_ADDR)]);
    const map = await loadMandates(undefined as never, ['g1', 'g1', null, undefined, 'g1'], fetch as never);
    expect(map.size).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['g1']);
  });

  it('returns an empty map without calling the fetch on an empty/nullish-only id list', async () => {
    const { fetch, calls } = fakeFetch([]);
    const empty = await loadMandates(undefined as never, [], fetch as never);
    expect(empty.size).toBe(0);
    const nullish = await loadMandates(undefined as never, [null, undefined], fetch as never);
    expect(nullish.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
