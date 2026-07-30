/// <reference types="@cloudflare/workers-types" />
// Tally/vote sync tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { buildInsertGovernanceAction, getGovernanceActionByTopicId, markVotesSynced } from '../db/governance.js';
import { getVotesByGaId, recordLocalVote, getViewerVote, upsertVotes } from '../db/drepVotes.js';
import { syncGovernanceTallies, syncGovernanceVotes, deriveStatus, backfillVotedPower, backfillFinalizedVotes, backfillGovStatusTimes, reconcilePendingVotes, backfillVoteMetaHashes, backfillThresholdSnapshots } from './tallySync.js';
import { activityInsert } from '../db/activity.js';
import { getActionsNeedingVoteBackfill } from '../db/governance.js';
import { getDrepVotingHistory, getVotesNeedingMetaHash } from '../db/drepVotes.js';
import { upsertProtocolParams, type ProtocolParams } from '../db/protocolParams.js';
import { readThresholdSnapshot } from './thresholds.js';
import type { ProposalListRow, VotingSummary, ProposalVoteRow, VoteListRow, EpochParamsRow } from '../koios/client.js';
import { epochStartMs, resolveNetwork } from '../config/network.js';

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
  // Pool power buckets present (0, as Koios returns for a treasury action where SPOs
  // do not vote), so spoEligiblePower resolves to 0 rather than null and the backfill
  // counts the row as filled on the second pass.
  pool_active_yes_vote_power: '0',
  pool_no_vote_power: '0',
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
    // Both were vote-synced while active (the vote sync set the marker).
    await markVotesSynced(db(), a.id, NOW);
    await markVotesSynced(db(), b.id, NOW);

    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash), lifeRow(b.txHash)]),
      db: db(),
      currentEpoch: 295,
      now: NOW + 20,
    });

    // a froze (past expiry) and must re-enter the finalized-votes backfill queue
    // so votes cast between the last vote sync and the freeze are picked up.
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

describe('syncGovernanceTallies re-syncs ratified actions until enacted', () => {
  it('flips a frozen ratified action to enacted once Koios sets enacted_epoch', async () => {
    const a = await insertActive(640);

    // First run: Koios reports ratified_epoch but not yet enacted_epoch (the
    // ~1-epoch window between ratification and enactment). The action freezes
    // as 'ratified'. Before the fix this was the end of the line: a ratified row
    // was excluded from the syncable set and never re-read.
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash, { ratified_epoch: 637 })]),
      db: db(),
      currentEpoch: 638,
      now: NOW + 10,
    });
    expect((await getGovernanceActionByTopicId(db(), a.topicId))!.status).toBe('ratified');

    // A later run: Koios has now set enacted_epoch (already in the past). The
    // ratified row must be re-checked against the fresh lifecycle and advanced
    // to 'enacted', not left stuck on 'ratified' forever.
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash, { ratified_epoch: 637, enacted_epoch: 638 })]),
      db: db(),
      currentEpoch: 639,
      now: NOW + 20,
    });
    expect((await getGovernanceActionByTopicId(db(), a.topicId))!.status).toBe('enacted');
  });

  it('advances ratified -> enacted without re-pulling the frozen tally or votes', async () => {
    const a = await insertActive(640);

    // Freeze to ratified with a real tally, then simulate the one finalised-vote
    // backfill that runs when an action freezes (it set votes_synced_at).
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash, { ratified_epoch: 637 })]),
      db: db(),
      currentEpoch: 638,
      now: NOW + 10,
    });
    await markVotesSynced(db(), a.id, NOW + 12);
    const frozen = (await getGovernanceActionByTopicId(db(), a.topicId))!;
    expect(frozen.status).toBe('ratified');
    expect(frozen.drepNo).toBe(5);

    const r = await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash, { ratified_epoch: 637, enacted_epoch: 638 })]),
      db: db(),
      currentEpoch: 639,
      now: NOW + 20,
    });
    expect(r.reSynced).toBe(1);

    const got = (await getGovernanceActionByTopicId(db(), a.topicId))!;
    expect(got.status).toBe('enacted');
    expect(got.decidedEpoch).toBe(638); // advanced from ratified_epoch to enacted_epoch
    expect(got.drepNo).toBe(5); // frozen tally left intact (no re-fetch)
    // The status-only re-check must NOT null votes_synced_at: re-queuing an
    // already-pulled finalised vote list every run would be wasteful.
    const queued = await getActionsNeedingVoteBackfill(db(), 50);
    expect(queued.map((g) => g.id)).not.toContain(a.id);
  });

  it('leaves an action ratified while enacted_epoch is still unset', async () => {
    const a = await insertActive(640);
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash, { ratified_epoch: 637 })]),
      db: db(),
      currentEpoch: 638,
      now: NOW + 10,
    });

    // Still inside the ratified window (Koios has not set enacted_epoch): the row
    // stays ratified and nothing is re-synced.
    const r = await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(a.txHash, { ratified_epoch: 637 })]),
      db: db(),
      currentEpoch: 638,
      now: NOW + 20,
    });
    expect(r.reSynced).toBe(0);
    expect((await getGovernanceActionByTopicId(db(), a.topicId))!.status).toBe('ratified');
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
      poolInfoBatch: async () => [],
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
      poolInfoBatch: async () => [],
    };

    const r = await syncGovernanceVotes({ koios, db: db(), now: NOW, limit: 2 });
    expect(r.actions).toBe(2);

    // Exactly two of the three actions have votes stored this run; the third waits.
    const sizes = await Promise.all([a, b, c].map((x) => getVotesByGaId(db(), x.id)));
    expect(sizes.filter((m) => m.size > 0).length).toBe(2);
  });

  it('archives the old vote when a re-vote arrives via the sync', async () => {
    const a = await insertActive(400);
    await upsertVotes(db(), a.id, [
      { voterRole: 'DRep', voterId: 'drep1re', voterHex: null, vote: 'Abstain', metaUrl: 'ipfs://old', metaHash: 'aa'.repeat(32), blockTime: 100 },
    ], NOW - 1000);
    const koios = {
      async proposalVotes(pid: string, _limit?: number, offset?: number): Promise<ProposalVoteRow[]> {
        return (offset ?? 0) === 0 && pid === a.proposalId
          ? [{ voter_role: 'DRep', voter_id: 'drep1re', voter_hex: null, vote: 'No', meta_url: 'ipfs://new', meta_hash: 'bb'.repeat(32), block_time: 200 }]
          : [];
      },
      poolInfoBatch: async () => [],
    };

    await syncGovernanceVotes({ koios, db: db(), now: NOW });

    const hist = (
      await db().prepare(`SELECT vote, block_time FROM drep_vote_history WHERE ga_id = ? AND voter_id = 'drep1re'`).bind(a.id).all<{ vote: string; block_time: number }>()
    ).results;
    expect(hist).toEqual([{ vote: 'Abstain', block_time: 100 }]);
    expect((await getVotesByGaId(db(), a.id)).get('drep1re')!.vote).toBe('No');
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
      poolInfoBatch: async () => [],
    };

    await syncGovernanceVotes({ koios, db: db(), now: NOW, maxPages: 3 });
    expect(calls).toBe(3); // bounded; did not run away
    expect((await getVotesByGaId(db(), a.id)).size).toBe(3000);
  });

  it('threads followedDrepIds into upsertVotes, emitting a fan-out job for a followed DRep vote', async () => {
    const a = await insertActive(400);
    const koios = {
      async proposalVotes(pid: string, _limit?: number, offset?: number): Promise<ProposalVoteRow[]> {
        return (offset ?? 0) === 0 && pid === a.proposalId
          ? [{ voter_role: 'DRep', voter_id: 'drepFollowedLive', voter_hex: null, vote: 'Yes', block_time: 100 }]
          : [];
      },
    };

    await syncGovernanceVotes({ koios, db: db(), now: NOW, followedDrepIds: new Set(['drepFollowedLive']) });

    const jobs = await db()
      .prepare('SELECT event_type, subject_id FROM notification_fanout_jobs WHERE subject_id = ?')
      .bind('drepFollowedLive')
      .all<{ event_type: string; subject_id: string }>();
    expect(jobs.results).toHaveLength(1);
    expect(jobs.results[0].event_type).toBe('delegator_drep_voted');
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
      poolInfoBatch: async () => [],
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
      poolInfoBatch: async () => [],
    };

    const r = await backfillFinalizedVotes({ koios, db: env.DB, now: 999, limit: 10, maxPages: 3 });
    expect(calls).toBe(3); // bounded; did not run away
    expect(r.votes).toBe(3000);
    // Marked synced despite the cap, so it cannot stall the backfill every run.
    expect(await getActionsNeedingVoteBackfill(env.DB, 10)).toEqual([]);
  });

  it('never emits a fan-out job, even when followedDrepIds is present in deps', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaBackfillNoFanout', 'InfoAction', 'Old Action', 'enacted', 'propBackfillNoFanout', NULL, 0, 0)`,
    ).run();

    const koios = {
      proposalVotes: async (_p: string, _l?: number, offset = 0) =>
        offset === 0 ? [{ voter_role: 'DRep', voter_id: 'drepFollowedBackfill', voter_hex: null, vote: 'Yes', block_time: 100 }] : [],
    };

    // Even though the deps interface accepts followedDrepIds, backfillFinalizedVotes
    // must not thread it through: re-writing historical votes must never fan out.
    await backfillFinalizedVotes({ koios, db: env.DB, now: 999, limit: 10, followedDrepIds: new Set(['drepFollowedBackfill']) });

    const jobs = await env.DB.prepare('SELECT * FROM notification_fanout_jobs WHERE subject_id = ?').bind('drepFollowedBackfill').all();
    expect(jobs.results).toHaveLength(0);
  });
});

describe('backfillGovStatusTimes', () => {
  it('redates a stale gov_status event to its on-chain epoch boundary, leaving others, and is idempotent', async () => {
    const a = await insertActive(294);
    // The action is now enacted, decided in epoch 292.
    await db().prepare("UPDATE governance_actions SET status = 'enacted', decided_epoch = 292 WHERE id = ?").bind(a.id).run();
    // A backlog catch-up wrote the enacted event at detection time (wrong). The
    // older ratified event is already near its true time and must be left alone
    // (its epoch is not recoverable from the action's single decided_epoch).
    await activityInsert(db(), { type: 'gov_status', topicId: a.topicId, payload: { from: 'ratified', to: 'enacted' }, createdAt: NOW }).run();
    await activityInsert(db(), { type: 'gov_status', topicId: a.topicId, payload: { from: 'active', to: 'ratified' }, createdAt: NOW - 500 }).run();

    const r = await backfillGovStatusTimes({ db: db(), network: 'mainnet', limit: 100 });
    expect(r.updated).toBe(1);

    const expected = epochStartMs(292, resolveNetwork('mainnet'));
    const rows = (
      await db()
        .prepare("SELECT json_extract(payload, '$.to') AS to_status, created_at FROM activity WHERE type = 'gov_status' AND topic_id = ?")
        .bind(a.topicId)
        .all<{ to_status: string; created_at: number }>()
    ).results;
    expect(rows.find((x) => x.to_status === 'enacted')!.created_at).toBe(expected);
    expect(rows.find((x) => x.to_status === 'ratified')!.created_at).toBe(NOW - 500);

    // Settled: a second run rewrites nothing.
    const r2 = await backfillGovStatusTimes({ db: db(), network: 'mainnet', limit: 100 });
    expect(r2.updated).toBe(0);
  });
});

describe('reconcilePendingVotes', () => {
  it('flags votes older than the window failed', async () => {
    const gaId = `${'d'.repeat(64)}#0`, drepId = `drep1${'z'.repeat(50)}`;
    // submit time 0; "now" far past the 6h window
    await recordLocalVote(env.DB, { gaId, drepId, voterHex: null, vote: 'yes', metaUrl: null, txHash: 'tx', now: 0 });
    await reconcilePendingVotes(env.DB, 7 * 3600);
    expect((await getViewerVote(env.DB, gaId, drepId))?.local_status).toBe('failed');
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

  it('dates a gov_status event at the on-chain epoch boundary, not detection time', async () => {
    const { txHash, topicId } = await insertActive(294);

    // Detected now (NOW), but enacted on-chain back in epoch 292. The feed time
    // must read the enactment boundary, not when our sync happened to notice it
    // (which for a backlog catch-up can be many days late).
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash, { enacted_epoch: 292 })]),
      db: db(),
      currentEpoch: 293,
      now: NOW,
      network: 'mainnet',
    });

    const expected = epochStartMs(292, resolveNetwork('mainnet'));
    const row = await db()
      .prepare("SELECT created_at FROM activity WHERE type = 'gov_status' AND topic_id = ?")
      .bind(topicId)
      .first<{ created_at: number }>();
    expect(row!.created_at).toBe(expected);
    expect(row!.created_at).not.toBe(NOW);
  });

  it('emits ratified -> enacted when the lifecycle re-check advances a frozen row', async () => {
    const { txHash, topicId } = await insertActive(640);

    // First freeze to ratified (emits pending -> ratified).
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash, { ratified_epoch: 637 })]),
      db: db(),
      currentEpoch: 638,
      now: NOW,
    });
    // Later run with enacted_epoch set: the re-check advances it and emits a
    // second milestone so the feed shows both "was ratified" and "was enacted".
    await syncGovernanceTallies({
      koios: fakeTallyKoios([lifeRow(txHash, { ratified_epoch: 637, enacted_epoch: 638 })]),
      db: db(),
      currentEpoch: 639,
      now: NOW + 1000,
    });

    const events = await statusEvents(topicId);
    expect(events).toEqual([
      { from: 'pending', to: 'ratified' },
      { from: 'ratified', to: 'enacted' },
    ]);
  });
});

describe('backfillVoteMetaHashes', () => {
  it('fills a missing hash from the voter vote list and drains the candidate', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaBF', 'TreasuryWithdrawals', 'BF', 'ratified', 'propBF', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaBF',
      [{ voterRole: 'DRep', voterId: 'drepBF', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://doc', metaHash: null, blockTime: 500 }],
      0,
    );

    const asked: Array<[string, string]> = [];
    const koios = {
      voterProposalVoteList: async (voterId: string, proposalId: string): Promise<VoteListRow[]> => {
        asked.push([voterId, proposalId]);
        return [{ meta_url: 'ipfs://doc', meta_hash: 'abc123', block_time: 500 }];
      },
    };

    const r = await backfillVoteMetaHashes({ koios, db: env.DB, limit: 10 });
    expect(asked).toEqual([['drepBF', 'propBF']]);
    expect(r).toEqual({ votes: 1, failed: 0 });

    const row = await env.DB
      .prepare("SELECT meta_hash FROM drep_votes WHERE ga_id='gaBF' AND voter_id='drepBF'")
      .first<{ meta_hash: string | null }>();
    expect(row?.meta_hash).toBe('abc123');

    expect(await getVotesNeedingMetaHash(env.DB, 10)).toEqual([]);
  });

  it('prefers the history row matching the stored block_time over the newest', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaBFrv', 'TreasuryWithdrawals', 'RV', 'expired', 'propBFrv', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaBFrv',
      [{ voterRole: 'DRep', voterId: 'drepRV', voterHex: null, vote: 'No', metaUrl: 'ipfs://same', metaHash: null, blockTime: 100 }],
      0,
    );

    const koios = {
      voterProposalVoteList: async (): Promise<VoteListRow[]> => [
        { meta_url: 'ipfs://same', meta_hash: 'hashNew', block_time: 200 },
        { meta_url: 'ipfs://same', meta_hash: 'hashOld', block_time: 100 },
      ],
    };

    const r = await backfillVoteMetaHashes({ koios, db: env.DB, limit: 10 });
    expect(r.failed).toBe(0);

    const row = await env.DB
      .prepare("SELECT meta_hash FROM drep_votes WHERE ga_id='gaBFrv' AND voter_id='drepRV'")
      .first<{ meta_hash: string | null }>();
    expect(row?.meta_hash).toBe('hashOld');
  });

  it('falls back to the newest row when the stored block_time is unknown', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaBFnb', 'TreasuryWithdrawals', 'NB', 'enacted', 'propBFnb', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaBFnb',
      [{ voterRole: 'DRep', voterId: 'drepNB', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://doc', metaHash: null, blockTime: null }],
      0,
    );

    const koios = {
      voterProposalVoteList: async (): Promise<VoteListRow[]> => [
        { meta_url: 'ipfs://doc', meta_hash: 'hashNewest', block_time: 900 },
        { meta_url: 'ipfs://prev', meta_hash: 'hashPrev', block_time: 100 },
      ],
    };

    await backfillVoteMetaHashes({ koios, db: env.DB, limit: 10 });

    const row = await env.DB
      .prepare("SELECT meta_hash FROM drep_votes WHERE ga_id='gaBFnb' AND voter_id='drepNB'")
      .first<{ meta_hash: string | null }>();
    expect(row?.meta_hash).toBe('hashNewest');
  });

  it('counts a vote with no resolvable hash as failed and leaves it untouched', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaBFmiss', 'TreasuryWithdrawals', 'Miss', 'expired', 'propBFmiss', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaBFmiss',
      [{ voterRole: 'DRep', voterId: 'drepMiss', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://doc', metaHash: null, blockTime: 500 }],
      0,
    );

    const koios = { voterProposalVoteList: async (): Promise<VoteListRow[]> => [] };

    const r = await backfillVoteMetaHashes({ koios, db: env.DB, limit: 10 });
    expect(r).toEqual({ votes: 0, failed: 1 });

    const row = await env.DB
      .prepare("SELECT meta_hash FROM drep_votes WHERE ga_id='gaBFmiss' AND voter_id='drepMiss'")
      .first<{ meta_hash: string | null }>();
    expect(row?.meta_hash).toBeNull();
  });

  it('refuses a hash whose anchor URL differs from the stored one', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaBFurl', 'TreasuryWithdrawals', 'Url', 'expired', 'propBFurl', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaBFurl',
      [{ voterRole: 'DRep', voterId: 'drepUrl', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://doc', metaHash: null, blockTime: null }],
      0,
    );

    const koios = {
      voterProposalVoteList: async (): Promise<VoteListRow[]> => [
        { meta_url: 'ipfs://other', meta_hash: 'hashOther', block_time: 500 },
      ],
    };

    const r = await backfillVoteMetaHashes({ koios, db: env.DB, limit: 10 });
    expect(r).toEqual({ votes: 0, failed: 1 });

    const row = await env.DB
      .prepare("SELECT meta_hash FROM drep_votes WHERE ga_id='gaBFurl' AND voter_id='drepUrl'")
      .first<{ meta_hash: string | null }>();
    expect(row?.meta_hash).toBeNull();
  });

  it('isolates a per-vote Koios failure and continues with the rest', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaBFerr', 'TreasuryWithdrawals', 'Err', 'expired', 'propBFerr', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaBFerr',
      [
        { voterRole: 'DRep', voterId: 'drepA', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://a', metaHash: null, blockTime: 10 },
        { voterRole: 'DRep', voterId: 'drepB', voterHex: null, vote: 'No', metaUrl: 'ipfs://b', metaHash: null, blockTime: 20 },
      ],
      0,
    );

    const koios = {
      voterProposalVoteList: async (voterId: string): Promise<VoteListRow[]> => {
        if (voterId === 'drepA') throw new Error('koios down');
        return [{ meta_url: 'ipfs://b', meta_hash: 'hashB', block_time: 20 }];
      },
    };

    const r = await backfillVoteMetaHashes({ koios, db: env.DB, limit: 10 });
    expect(r).toEqual({ votes: 1, failed: 1 });

    const rows = await env.DB
      .prepare("SELECT voter_id, meta_hash FROM drep_votes WHERE ga_id='gaBFerr' ORDER BY voter_id")
      .all<{ voter_id: string; meta_hash: string | null }>();
    expect(rows.results).toEqual([
      { voter_id: 'drepA', meta_hash: null },
      { voter_id: 'drepB', meta_hash: 'hashB' },
    ]);
  });
});

describe('getVotesNeedingMetaHash', () => {
  it('selects an anchored vote on a finalized action missing its meta_hash', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaMH', 'TreasuryWithdrawals', 'Old', 'ratified', 'propMH', NULL, 0, 0)`,
    ).run();
    // Historical shape: anchor URL present, hash missing.
    await upsertVotes(
      env.DB,
      'gaMH',
      [{ voterRole: 'DRep', voterId: 'drep1', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://x', metaHash: null, blockTime: 42 }],
      0,
    );

    const rows = await getVotesNeedingMetaHash(env.DB, 10);
    expect(rows).toContainEqual({ ga_id: 'gaMH', proposal_id: 'propMH', voter_id: 'drep1', meta_url: 'ipfs://x', block_time: 42 });
  });

  it('excludes votes that already carry a hash', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaMH2', 'TreasuryWithdrawals', 'Hashed', 'ratified', 'propMH2', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaMH2',
      [{ voterRole: 'DRep', voterId: 'drep2', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://y', metaHash: 'deadbeef' }],
      0,
    );
    const ids = (await getVotesNeedingMetaHash(env.DB, 10)).map((v) => v.ga_id);
    expect(ids).not.toContain('gaMH2');
  });

  it('excludes votes on active actions and votes with no anchor', async () => {
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaActive', 'TreasuryWithdrawals', 'Active', 'active', 'propAct', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaActive',
      [{ voterRole: 'DRep', voterId: 'drep3', voterHex: null, vote: 'Yes', metaUrl: 'ipfs://z', metaHash: null }],
      0,
    );
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, title, status, proposal_id, topic_id, created_at, last_synced_at)
       VALUES ('gaNoAnchor', 'InfoAction', 'NoAnchor', 'enacted', 'propNo', NULL, 0, 0)`,
    ).run();
    await upsertVotes(
      env.DB,
      'gaNoAnchor',
      [{ voterRole: 'DRep', voterId: 'drep4', voterHex: null, vote: 'Yes', metaUrl: null, metaHash: null }],
      0,
    );
    const ids = (await getVotesNeedingMetaHash(env.DB, 10)).map((v) => v.ga_id);
    expect(ids).not.toContain('gaActive');
    expect(ids).not.toContain('gaNoAnchor');
  });
});

describe('backfillThresholdSnapshots', () => {
  const params: ProtocolParams = {
    epoch: 640,
    dvtMotionNoConfidence: null, dvtCommitteeNormal: null, dvtCommitteeNoConfidence: null,
    dvtUpdateConstitution: null, dvtHardFork: null, dvtPpNetwork: null, dvtPpEconomic: null,
    dvtPpTechnical: null, dvtPpGov: null, dvtTreasuryWithdrawal: 0.67,
    pvtMotionNoConfidence: null, pvtCommitteeNormal: null, pvtCommitteeNoConfidence: null,
    pvtHardFork: null, pvtSecurityGroup: null, ccThreshold: 0.667,
    committeeMinSize: 5, committeeSize: 6, syncedAt: NOW, rawJson: null,
    treasuryLovelace: null, reservesLovelace: null, treasuryEpoch: null,
  };

  // Seeds a committee of `n` members all active at any epoch >= 500.
  async function seedCommittee(n: number) {
    await db().prepare('DELETE FROM committee_member').run();
    for (let i = 0; i < n; i++) {
      await db()
        .prepare(
          `INSERT INTO committee_member (cold_key_hex, version_from, version_to, term_expiration, authorized_from, resigned_at)
           VALUES (?, 500, NULL, 999, 500, NULL)`,
        )
        .bind(`cold${i}`)
        .run();
    }
  }

  // Freezes an inserted action to a terminal status with a decided epoch and a cc yes pct.
  async function terminal(decidedEpoch: number | null, expiryEpoch: number | null) {
    const ga = await insertActive(expiryEpoch);
    await db()
      .prepare(`UPDATE governance_actions SET status = 'enacted', decided_epoch = ?, expiry_epoch = ?, cc_yes_pct = 80, drep_yes_pct = 90, thresholds_json = NULL WHERE id = ?`)
      .bind(decidedEpoch, expiryEpoch, ga.id)
      .run();
    return ga;
  }

  function fakeKoios() {
    const calls: (number | undefined)[] = [];
    return {
      calls,
      async epochParams(epochNo?: number): Promise<EpochParamsRow | null> {
        calls.push(epochNo);
        return { epoch_no: epochNo ?? null, committee_min_size: epochNo === 600 ? 7 : 5 };
      },
    };
  }

  async function snapOf(topicId: string) {
    const row = await db().prepare('SELECT thresholds_json FROM governance_actions WHERE topic_id = ?').bind(topicId).first<{ thresholds_json: string | null }>();
    return readThresholdSnapshot(row?.thresholds_json ?? null);
  }

  it('freezes the cc quorum gate from the decision-epoch min size and the committee timeline', async () => {
    await upsertProtocolParams(db(), params);
    await seedCommittee(6); // 6 active members
    const a1 = await terminal(600, 605); // min size 7 at epoch 600 -> 6 < 7 -> below min
    const a2 = await terminal(600, 606); // same epoch -> epoch_params cached

    const koios = fakeKoios();
    const res = await backfillThresholdSnapshots({ koios, db: db(), limit: 10 });
    expect(res.actions).toBe(2);
    expect(res.failed).toBe(0);

    const s1 = await snapOf(a1.topicId);
    expect(s1?.ccBelowMinSize).toBe(true);
    expect(s1?.v).toBe(2);
    expect(s1?.cc).toBeCloseTo(66.7, 0); // ccThreshold 0.667 -> ~66.7%
    expect((await snapOf(a2.topicId))?.ccBelowMinSize).toBe(true);

    // epoch_params fetched once for the shared epoch 600 (cached across both actions).
    expect(koios.calls.filter((e) => e === 600)).toHaveLength(1);

    // Fully drained: a second run finds nothing.
    const second = await backfillThresholdSnapshots({ koios: fakeKoios(), db: db(), limit: 10 });
    expect(second.actions).toBe(0);
  });

  it('drains an action with no decision epoch, leaving the gate null', async () => {
    await upsertProtocolParams(db(), params);
    await seedCommittee(6);
    const a = await terminal(null, null);
    const res = await backfillThresholdSnapshots({ koios: fakeKoios(), db: db(), limit: 10 });
    expect(res.actions).toBe(1);
    const s = await snapOf(a.topicId);
    expect(s?.ccBelowMinSize).toBeNull();
    expect(s?.v).toBe(2);
  });

  it('skips the run (drains nothing) when protocol params are not synced', async () => {
    await seedCommittee(6);
    await terminal(600, 605); // no upsertProtocolParams
    const res = await backfillThresholdSnapshots({ koios: fakeKoios(), db: db(), limit: 10 });
    expect(res.actions).toBe(0);
  });
});
