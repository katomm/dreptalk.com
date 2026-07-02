import { describe, expect, it } from 'vitest';
import { votePowers } from './tallySync.js';

describe('votePowers', () => {
  it('SPO no/abstain come from the ACTIVE buckets, not the default-polluted totals', () => {
    const summary = {
      pool_active_yes_vote_power: '100',
      pool_active_no_vote_power: '200',
      pool_active_abstain_vote_power: '300',
      // default-polluted fields that must NOT be used for spoNo/spoAbstain:
      pool_no_vote_power: '999999',
      pool_passive_always_abstain_vote_power: '888888',
      drep_active_yes_vote_power: '10',
      drep_active_no_vote_power: '20',
      drep_active_abstain_vote_power: '30',
    } as any;
    const p = votePowers(summary);
    expect(p.spoYesPower).toBe(100);
    expect(p.spoNoPower).toBe(200); // active no, not 999999
    expect(p.spoAbstainPower).toBe(300); // active abstain, not 888888
    expect(p.drepNoPower).toBe(20);
  });
});
