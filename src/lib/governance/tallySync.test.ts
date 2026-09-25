import { describe, expect, it } from 'vitest';
import { votePowers, enrichVotedPower, deriveStatus } from './tallySync.js';
import type { VoteInput } from '../db/drepVotes.js';
import type { ProposalListRow } from '../koios/client.js';

function lifeRow(txHash: string, over: Partial<ProposalListRow> = {}): ProposalListRow {
  return {
    proposal_id: `gov_${txHash}`,
    proposal_tx_hash: txHash,
    proposal_index: 0,
    proposal_type: 'TreasuryWithdrawals',
    ...over,
  } as ProposalListRow;
}

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

describe('deriveStatus', () => {
  const ga = { expiryEpoch: 294 } as never;
  it('prefers terminal lifecycle epochs', () => {
    expect(deriveStatus(lifeRow('x', { enacted_epoch: 300 }), ga, 290)).toBe('enacted');
    expect(deriveStatus(lifeRow('x', { ratified_epoch: 300 }), ga, 290)).toBe('ratified');
    expect(deriveStatus(lifeRow('x', { dropped_epoch: 300 }), ga, 290)).toBe('dropped');
  });
  it('resolves enacted once enacted_epoch has passed, even with ratified_epoch also set', () => {
    // The real stuck-on-ratified scenario: an action carries BOTH ratified_epoch
    // and (a later) enacted_epoch, with the current epoch past enacted_epoch.
    // enacted wins over ratified, so the row is 'enacted', not 'ratified'.
    expect(deriveStatus(lifeRow('x', { ratified_epoch: 637, enacted_epoch: 638 }), ga, 639)).toBe('enacted');
  });
  it('labels an expired-then-dropped action as expired (expiry is the real outcome)', () => {
    // The chain marks a timed-out action expired, then drops it the next epoch,
    // so both epochs are set; expiry must win over the dropped bookkeeping.
    expect(deriveStatus(lifeRow('x', { expired_epoch: 300, dropped_epoch: 301 }), ga, 305)).toBe('expired');
  });
  it('closes an info action instead of expiring/dropping it (it can never enact)', () => {
    const info = { type: 'InfoAction', expiryEpoch: 294 } as never;
    expect(deriveStatus(lifeRow('x', { expired_epoch: 300, dropped_epoch: 301 }), info, 305)).toBe('closed');
    expect(deriveStatus(lifeRow('x'), info, 295)).toBe('closed'); // expiry fallback
    expect(deriveStatus(lifeRow('x'), info, 290)).toBe('active'); // still open
  });
  it('expires by epoch when no terminal epoch', () => {
    expect(deriveStatus(lifeRow('x'), ga, 295)).toBe('expired');
    expect(deriveStatus(lifeRow('x'), ga, 290)).toBe('active');
  });
  it('treats currentEpoch === expiry as decided (voting ends entering the expiry epoch)', () => {
    // On-chain an action expires AT the start of its expiration epoch
    // (expired_epoch === expiration), so currentEpoch === expiry is already over.
    // The explicit lifecycle checks usually catch this first; this fallback only
    // fires when Koios lags the boundary and has not yet set a terminal epoch.
    expect(deriveStatus(lifeRow('x'), ga, 294)).toBe('expired'); // via ga.expiryEpoch
    // Same boundary via the Koios proposal_list expiration field.
    const noExpiry = { type: 'TreasuryWithdrawals' } as never;
    expect(deriveStatus(lifeRow('x', { expiration: 294 }), noExpiry, 294)).toBe('expired');
    // Info actions close rather than expire at the boundary.
    const info = { type: 'InfoAction', expiryEpoch: 294 } as never;
    expect(deriveStatus(lifeRow('x'), info, 294)).toBe('closed');
  });
});
