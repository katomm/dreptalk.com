import { describe, expect, it } from 'vitest';
import { votePowers, enrichVotedPower } from './tallySync.js';
import type { VoteInput } from '../db/drepVotes.js';

function fakeDb(drepPower: Record<string, string>) {
  return {
    prepare() {
      return {
        bind(...ids: string[]) {
          return {
            async all() {
              return { results: ids.filter((id) => id in drepPower).map((id) => ({ drep_id: id, voting_power: drepPower[id] })) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('enrichVotedPower', () => {
  it('sets DRep power from the db and SPO power from Koios, leaving CC null', async () => {
    const votes: VoteInput[] = [
      { voterRole: 'DRep', voterId: 'drep1', voterHex: null, vote: 'Yes' },
      { voterRole: 'SPO', voterId: 'pool1', voterHex: null, vote: 'Yes' },
      { voterRole: 'ConstitutionalCommittee', voterId: 'cc1', voterHex: 'hot1', vote: 'Yes' },
    ];
    const koios = { async poolInfoBatch() { return [{ pool_id_bech32: 'pool1', active_stake: '4200' }] as never; } };
    await enrichVotedPower({ db: fakeDb({ drep1: '1500' }), koios }, votes);
    expect(votes[0].votedPower).toBe(1500);
    expect(votes[1].votedPower).toBe(4200);
    expect(votes[2].votedPower ?? null).toBeNull();
  });
});

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
