import { describe, it, expect } from 'vitest';
import { describeAuthor } from './author.js';
import type { User } from '../db/users.js';
import type { Drep } from '../db/dreps.js';
import type { Pool } from '../db/pools.js';

const user = (over: Partial<User>): User => ({
  id: 'u1', drep_id: null, stake_addr: null, pool_id: null, cc_cred: null,
  is_drep: false, is_spo: false, is_cc: false, is_proposer: false,
  role: 'member', status: 'active', display_name: null, bio: null,
  avatar_url: null, created_at: 0, last_verified_at: 0, ...over,
});

describe('describeAuthor identiconSeed', () => {
  it('uses the DRep credential hex as the seed when the author is a DRep', () => {
    const users = new Map([['u1', user({ drep_id: 'drep1xyz' })]]);
    const dreps = new Map([['drep1xyz', { drepId: 'drep1xyz', hex: 'deadbeef', name: 'Alice' } as Drep]]);
    expect(describeAuthor('u1', users, dreps, new Map()).identiconSeed).toBe('deadbeef');
  });

  it('falls back to the author id when there is no DRep', () => {
    const users = new Map([['u1', user({})]]);
    expect(describeAuthor('u1', users, new Map(), new Map()).identiconSeed).toBe('u1');
  });
});

describe('describeAuthor SPO pool resolution', () => {
  it('resolves an SPO user to the pool name with no drep profile link', () => {
    const users = new Map([['u1', user({
      id: 'u1', drep_id: null, pool_id: 'pool1a', display_name: null,
      is_drep: false, is_spo: true, is_cc: false, is_proposer: false, role: 'user',
    } as never)]]);
    const pools = new Map<string, Pool>([['pool1a', {
      poolId: 'pool1a', poolHash: 'aa', ticker: 'HEPHY', name: 'Hephaestus Stake Pool',
      homepage: null, description: null, imageContentHash: 'imghash', imageStoredUrl: '/api/avatar/imghash',
    }]]);
    const d = describeAuthor('u1', users, new Map(), pools);
    expect(d.displayName).toBe('Hephaestus Stake Pool');
    expect(d.imageHash).toBe('imghash');
    expect(d.drepId).toBeNull();
    expect(d.badges).toContain('SPO');
  });

  it('falls back to ticker when the pool has no name', () => {
    const users = new Map([['u2', user({
      id: 'u2', drep_id: null, pool_id: 'pool1b', display_name: null,
      is_drep: false, is_spo: true, is_cc: false, is_proposer: false, role: 'user',
    } as never)]]);
    const pools = new Map<string, Pool>([['pool1b', {
      poolId: 'pool1b', poolHash: 'bb', ticker: 'COOL', name: null,
      homepage: null, description: null, imageContentHash: null, imageStoredUrl: null,
    }]]);
    expect(describeAuthor('u2', users, new Map(), pools).displayName).toBe('COOL');
  });
});
