import { describe, it, expect } from 'vitest';
import { describeAuthor } from './author.js';
import type { User } from '../db/users.js';
import type { Drep } from '../db/dreps.js';

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
    expect(describeAuthor('u1', users, dreps).identiconSeed).toBe('deadbeef');
  });

  it('falls back to the author id when there is no DRep', () => {
    const users = new Map([['u1', user({})]]);
    expect(describeAuthor('u1', users, new Map()).identiconSeed).toBe('u1');
  });
});
