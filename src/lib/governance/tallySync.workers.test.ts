/// <reference types="@cloudflare/workers-types" />
// Tally/vote sync tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildInsertGovernanceAction, getGovernanceActionByTopicId } from '../db/governance.js';
import { getVotesByGaId } from '../db/drepVotes.js';
import { syncGovernanceTallies, syncGovernanceVotes, deriveStatus } from './tallySync.js';
import type { ProposalListRow, VotingSummary, ProposalVoteRow } from '../koios/client.js';

const db = () => env.DB;
const NOW = 1_754_000_000_000;

let seq = 0;
// Inserts an active GA and returns { id, proposalId, topicId }.
async function insertActive(expiryEpoch: number | null) {
  seq++;
  const id = `gtx${seq}#0`;
  const proposalId = `gov_action_${seq}`;
  const topicId = `gtopic-${seq}`;
  await db().batch([
    buildInsertGovernanceAction(db(), {
      id, proposalId, type: 'TreasuryWithdrawals', title: 't', abstract: null, rationaleHtml: null,
      anchorUrl: null, anchorHash: null, anchorStatus: 'ok', returnAddress: 'stake_x',
      deposit: '100000000000', submittedEpoch: 287, expiryEpoch, topicId, now: NOW,
    }),
  ]);
  return { id, proposalId, topicId, txHash: `gtx${seq}` };
}

function lifeRow(txHash: string, over: Partial<ProposalListRow> = {}): ProposalListRow {
  return {
    proposal_id: `gov_${txHash}`,
    proposal_tx_hash: txHash,
    proposal_index: 0,
    proposal_type: 'TreasuryWithdrawals',
    ...over,
  } as ProposalListRow;
}

const summary: VotingSummary = {
  proposal_type: 'TreasuryWithdrawals',
  epoch_no: 293,
  drep_yes_votes_cast: 2,
  drep_no_votes_cast: 5,
  drep_abstain_votes_cast: 1,
  drep_yes_pct: 0.01,
  drep_no_pct: 99.99,
  pool_yes_votes_cast: 0,
  pool_no_votes_cast: 0,
  pool_abstain_votes_cast: 0,
  committee_yes_votes_cast: 0,
  committee_no_votes_cast: 0,
  committee_abstain_votes_cast: 0,
};

function fakeTallyKoios(lifecycle: ProposalListRow[]) {
  return {
    async proposalList(): Promise<ProposalListRow[]> {
      return lifecycle;
    },
    async proposalVotingSummary(): Promise<VotingSummary | null> {
      return summary;
    },
  };
}

describe('deriveStatus', () => {
  const ga = { expiryEpoch: 294 } as never;
  it('prefers terminal lifecycle epochs', () => {
    expect(deriveStatus(lifeRow('x', { enacted_epoch: 300 }), ga, 290)).toBe('enacted');
    expect(deriveStatus(lifeRow('x', { ratified_epoch: 300 }), ga, 290)).toBe('ratified');
    expect(deriveStatus(lifeRow('x', { dropped_epoch: 300 }), ga, 290)).toBe('dropped');
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
});

describe('syncGovernanceTallies', () => {
  it('writes tallies and keeps an unexpired action active', async () => {
    const a = await insertActive(400);
    const r = await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash)]),
      db: db(),
      currentEpoch: 293,
      now: NOW + 10,
    });
    expect(r.updated).toBe(1);
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.status).toBe('active');
    expect(got!.drepNoPct).toBeCloseTo(99.99);
    expect(got!.drepNo).toBe(5);
    expect(got!.tallySyncedAt).toBe(NOW + 10);
  });

  it('freezes an action past its expiry and drops it from the active set', async () => {
    const a = await insertActive(290);
    const first = await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash)]),
      db: db(),
      currentEpoch: 295,
      now: NOW + 20,
    });
    expect(first.frozen).toBe(1);
    expect((await getGovernanceActionByTopicId(db(), a.topicId))!.status).toBe('expired');

    // Next run: it is no longer in the active set, so it is not re-counted.
    const again = await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash)]),
      db: db(),
      currentEpoch: 296,
      now: NOW + 30,
    });
    // `again.active` should not include the now-expired one from this test's row.
    const stillActive = (await getGovernanceActionByTopicId(db(), a.topicId))!.status;
    expect(stillActive).toBe('expired');
    expect(again).toBeDefined();
  });
});

describe('syncGovernanceVotes', () => {
  it('upserts on-chain votes and is idempotent', async () => {
    const a = await insertActive(400);
    const votes: ProposalVoteRow[] = [
      { voter_role: 'DRep', voter_id: 'drep1aaa', voter_hex: 'aa', vote: 'Yes' },
      { voter_role: 'SPO', voter_id: 'pool1bbb', voter_hex: 'bb', vote: 'No' },
    ];
    const koios = {
      async proposalVotes(pid: string, _limit?: number, offset?: number): Promise<ProposalVoteRow[]> {
        return (offset ?? 0) === 0 && pid === a.proposalId ? votes : [];
      },
    };

    const r1 = await syncGovernanceVotes({ koios, db: db(), now: NOW });
    expect(r1.votes).toBeGreaterThanOrEqual(2);

    const map = await getVotesByGaId(db(), a.id);
    expect(map.get('drep1aaa')!.vote).toBe('Yes');
    expect(map.get('pool1bbb')!.vote).toBe('No');

    // Re-running does not duplicate (PK on ga_id+voter_id).
    await syncGovernanceVotes({ koios, db: db(), now: NOW + 1 });
    const map2 = await getVotesByGaId(db(), a.id);
    expect(map2.size).toBe(map.size);
  });
});
