/// <reference types="@cloudflare/workers-types" />
// Tally/vote sync tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildInsertGovernanceAction, getGovernanceActionByTopicId, markVotesSynced } from '../db/governance.js';
import { getVotesByGaId } from '../db/drepVotes.js';
import { syncGovernanceTallies, syncGovernanceVotes, deriveStatus, backfillVotedPower, backfillFinalizedVotes } from './tallySync.js';
import { getActionsNeedingVoteBackfill } from '../db/governance.js';
import { getDrepVotingHistory } from '../db/drepVotes.js';
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
      deposit: '100000000000', submittedEpoch: 287, expiryEpoch, metaVersion: 0, topicId, now: NOW,
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
  drep_active_yes_vote_power: '29497454745',
  drep_active_no_vote_power: '3536695673892',
  drep_active_abstain_vote_power: '0',
  pool_yes_votes_cast: 0,
  pool_no_votes_cast: 0,
  pool_abstain_votes_cast: 0,
  committee_yes_votes_cast: 0,
  committee_no_votes_cast: 0,
  committee_abstain_votes_cast: 0,
};

// 29497454745 + 3536695673892 + 0
const SUMMED_VOTED_POWER = 3566193128637;

function fakeTallyKoios(lifecycle: ProposalListRow[], s: VotingSummary | null = summary) {
  return {
    async proposalList(): Promise<ProposalListRow[]> {
      return lifecycle;
    },
    async proposalVotingSummary(): Promise<VotingSummary | null> {
      return s;
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
    expect(got!.drepVotedPower).toBe(SUMMED_VOTED_POWER);
    expect(got!.tallySyncedAt).toBe(NOW + 10);
  });

  it('stores null voted power when the summary lacks the active vote-power fields', async () => {
    const a = await insertActive(400);
    const bare: VotingSummary = {
      proposal_type: 'TreasuryWithdrawals',
      epoch_no: 293,
      drep_yes_votes_cast: 2,
      drep_no_votes_cast: 5,
      drep_abstain_votes_cast: 1,
    };
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash)], bare),
      db: db(),
      currentEpoch: 293,
      now: NOW + 10,
    });
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.drepVotedPower).toBeNull();
  });

  it('re-queues a frozen action for one final vote backfill, but not an active one', async () => {
    const a = await insertActive(290);
    const b = await insertActive(400);
    // Both were vote-synced while active (the hourly sync set the marker).
    await markVotesSynced(db(), a.id, NOW);
    await markVotesSynced(db(), b.id, NOW);

    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash), lifeRow(b.txHash)]),
      db: db(),
      currentEpoch: 295,
      now: NOW + 20,
    });

    // a froze (past expiry) and must re-enter the finalized-votes backfill queue
    // so votes cast between the last hourly sync and the freeze are picked up.
    expect((await getGovernanceActionByTopicId(db(), a.topicId))!.status).toBe('expired');
    expect((await getGovernanceActionByTopicId(db(), b.topicId))!.status).toBe('active');
    const queued = await getActionsNeedingVoteBackfill(db(), 10);
    expect(queued.map((g) => g.id)).toContain(a.id);
    expect(queued.map((g) => g.id)).not.toContain(b.id);
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

  it('processes never-synced actions first and respects the per-run limit', async () => {
    const a = await insertActive(400);
    const b = await insertActive(400);
    const c = await insertActive(400);
    const lifecycle = [lifeRow(a.txHash), lifeRow(b.txHash), lifeRow(c.txHash)];

    // limit 2: only two of the three never-synced actions are tallied this run.
    const r1 = await syncGovernanceTallies({
      koios: fakeTallyKoios(lifecycle), db: db(), currentEpoch: 293, now: NOW + 10, limit: 2,
    });
    expect(r1.active).toBe(2);
    expect(r1.updated).toBe(2);
    const afterRun1 = await Promise.all([a, b, c].map((x) => getGovernanceActionByTopicId(db(), x.topicId)));
    expect(afterRun1.filter((g) => g!.tallySyncedAt != null).length).toBe(2);

    // Next run picks up the remaining never-synced one (stale-first), draining the backlog.
    const r2 = await syncGovernanceTallies({
      koios: fakeTallyKoios(lifecycle), db: db(), currentEpoch: 293, now: NOW + 20, limit: 1,
    });
    expect(r2.updated).toBe(1);
    const afterRun2 = await Promise.all([a, b, c].map((x) => getGovernanceActionByTopicId(db(), x.topicId)));
    expect(afterRun2.filter((g) => g!.tallySyncedAt != null).length).toBe(3);
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

  it('bounds the per-run work by the limit', async () => {
    const a = await insertActive(400);
    const b = await insertActive(400);
    const c = await insertActive(400);
    const koios = {
      async proposalVotes(pid: string, _limit?: number, offset?: number): Promise<ProposalVoteRow[]> {
        return (offset ?? 0) === 0
          ? [{ voter_role: 'DRep', voter_id: `drep_${pid}`, voter_hex: 'aa', vote: 'Yes' }]
          : [];
      },
    };

    const r = await syncGovernanceVotes({ koios, db: db(), now: NOW, limit: 2 });
    expect(r.actions).toBe(2);

    // Exactly two of the three actions have votes stored this run; the third waits.
    const sizes = await Promise.all([a, b, c].map((x) => getVotesByGaId(db(), x.id)));
    expect(sizes.filter((m) => m.size > 0).length).toBe(2);
  });

  it('caps an endless vote list at maxPages instead of fetching forever', async () => {
    const a = await insertActive(400);
    let calls = 0;
    // Always returns a full page: an effectively endless (pathological) vote list.
    const koios = {
      async proposalVotes(_pid: string, limit = 1000, offset = 0): Promise<ProposalVoteRow[]> {
        calls++;
        return Array.from({ length: limit }, (_, k) => ({
          voter_role: 'DRep',
          voter_id: `drep_${offset + k}`,
          voter_hex: null,
          vote: 'Yes',
        }));
      },
    };

    await syncGovernanceVotes({ koios, db: db(), now: NOW, maxPages: 3 });
    expect(calls).toBe(3); // bounded; did not run away
    expect((await getVotesByGaId(db(), a.id)).size).toBe(3000);
  });
});

describe('backfillVotedPower', () => {
  // Seed a terminal action (no drep_voted_power yet) and return its ids.
  async function insertTerminal(status: string) {
    const ga = await insertActive(290);
    // Freeze it to the given terminal status with null voted power.
    await db()
      .prepare(
        `UPDATE governance_actions
           SET status = ?, drep_voted_power = NULL
         WHERE id = ?`,
      )
      .bind(status, ga.id)
      .run();
    return ga;
  }

  it('fills drep_voted_power for terminal actions without touching status', async () => {
    const expired = await insertTerminal('expired');
    const enacted = await insertTerminal('enacted');
    // Active: must NOT be backfilled (still null after the run).
    const active = await insertActive(400);

    const koios = {
      async proposalVotingSummary(_pid: string): Promise<VotingSummary | null> {
        return summary;
      },
    };

    const result = await backfillVotedPower({ koios, db: db(), limit: 10 });
    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);

    const gotExpired = await getGovernanceActionByTopicId(db(), expired.topicId);
    expect(gotExpired!.drepVotedPower).toBe(SUMMED_VOTED_POWER);
    expect(gotExpired!.status).toBe('expired');

    const gotEnacted = await getGovernanceActionByTopicId(db(), enacted.topicId);
    expect(gotEnacted!.drepVotedPower).toBe(SUMMED_VOTED_POWER);
    expect(gotEnacted!.status).toBe('enacted');

    // Active action must remain untouched.
    const gotActive = await getGovernanceActionByTopicId(db(), active.topicId);
    expect(gotActive!.drepVotedPower).toBeNull();
  });

  it('respects the limit so cron tick stays within budget', async () => {
    const t1 = await insertTerminal('dropped');
    const t2 = await insertTerminal('dropped');
    void t1; void t2;

    const koios = {
      async proposalVotingSummary(_pid: string): Promise<VotingSummary | null> {
        return summary;
      },
    };

    const result = await backfillVotedPower({ koios, db: db(), limit: 1 });
    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
  });

  it('returns scanned=0 on the second run when all actions are filled', async () => {
    const t = await insertTerminal('expired');
    const koios = {
      async proposalVotingSummary(_pid: string): Promise<VotingSummary | null> {
        return summary;
      },
    };

    await backfillVotedPower({ koios, db: db(), limit: 10 });
    const second = await backfillVotedPower({ koios, db: db(), limit: 10 });

    // The terminal from this test is now filled; it falls out of the candidate set.
    const got = await getGovernanceActionByTopicId(db(), t.topicId);
    expect(got!.drepVotedPower).toBe(SUMMED_VOTED_POWER);
    // scanned must be 0 for the actions seeded in this test (they are all filled).
    expect(second.scanned).toBe(0);
  });

  it('counts a failed Koios call in failed and continues', async () => {
    const t = await insertTerminal('ratified');
    let calls = 0;
    const koios = {
      async proposalVotingSummary(_pid: string): Promise<VotingSummary | null> {
        calls++;
        throw new Error('koios down');
      },
    };

    const result = await backfillVotedPower({ koios, db: db(), limit: 10 });
    // Scanned includes the candidate; failed counts the error; updated stays 0.
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(calls).toBeGreaterThanOrEqual(1);
    // The action remains unfilled.
    const got = await getGovernanceActionByTopicId(db(), t.topicId);
    expect(got!.drepVotedPower).toBeNull();
  });
});

describe('backfillFinalizedVotes', () => {
  it('pulls votes for a finalised action, writes them, and marks it synced', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaB', 'InfoAction', 'Old Action', 'enacted', 'propB', NULL, 0, 0)`,
    ).run();

    const koios = {
      proposalVotes: async (_p: string, _l?: number, offset = 0) =>
        offset === 0 ? [{ voter_role: 'DRep', voter_id: 'drepH', voter_hex: null, vote: 'Yes' }] : [],
    };

    const r = await backfillFinalizedVotes({ koios, db: env.DB, now: 999, limit: 10 });
    expect(r.actions).toBe(1);
    expect(r.votes).toBe(1);

    expect(await getDrepVotingHistory(env.DB, 'drepH', {})).toHaveLength(1);
    expect(await getActionsNeedingVoteBackfill(env.DB, 10)).toEqual([]); // now marked synced
  });

  it('caps a pathological finalised vote list and still marks the action synced', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaCap', 'InfoAction', 'Huge', 'enacted', 'propCap', NULL, 0, 0)`,
    ).run();

    let calls = 0;
    const koios = {
      // Endless full pages: the exact shape that used to kill the run mid-loop.
      proposalVotes: async (_p: string, limit = 1000, offset = 0): Promise<ProposalVoteRow[]> => {
        calls++;
        return Array.from({ length: limit }, (_, k) => ({
          voter_role: 'DRep',
          voter_id: `drep_${offset + k}`,
          voter_hex: null,
          vote: 'Yes',
        }));
      },
    };

    const r = await backfillFinalizedVotes({ koios, db: env.DB, now: 999, limit: 10, maxPages: 3 });
    expect(calls).toBe(3); // bounded; did not run away
    expect(r.votes).toBe(3000);
    // Marked synced despite the cap, so it cannot stall the backfill every run.
    expect(await getActionsNeedingVoteBackfill(env.DB, 10)).toEqual([]);
  });
});

describe('syncGovernanceTallies emits gov_status', () => {
  async function statusEvents(topicId: string) {
    return (
      await db()
        .prepare("SELECT payload FROM activity WHERE type = 'gov_status' AND topic_id = ? ORDER BY created_at ASC")
        .bind(topicId)
        .all<{ payload: string }>()
    ).results.map((r) => JSON.parse(r.payload));
  }

  it('does not emit on pending -> active (votable from submission, not a milestone)', async () => {
    const { txHash, topicId } = await insertActive(294);

    // pending (stored) -> active (derived): suppressed. On-chain the action is
    // votable from submission, so this is just our two-phase sync (discover, then
    // tally) settling, not a real lifecycle milestone worth a feed line.
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash)]),
      db: db(),
      currentEpoch: 290,
      now: NOW,
    });
    expect((await statusEvents(topicId)).length).toBe(0);

    // Second, unchanged sync: still nothing.
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash)]),
      db: db(),
      currentEpoch: 291,
      now: NOW + 1000,
    });
    expect((await statusEvents(topicId)).length).toBe(0);
  });

  it('emits on a transition to a terminal status', async () => {
    const { txHash, topicId } = await insertActive(294);

    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash, { enacted_epoch: 292 })]),
      db: db(),
      currentEpoch: 293,
      now: NOW,
    });
    const events = await statusEvents(topicId);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ from: 'pending', to: 'enacted' });
  });
});
