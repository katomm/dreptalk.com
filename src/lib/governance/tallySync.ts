// Tally + lifecycle sync for governance actions that are not yet finalized
// (status 'active' or 'pending'). Each cycle, for every such action: fetch its
// power-weighted vote summary, derive its lifecycle status from the proposal_list
// epoch fields, and persist both. A 'pending' action (freshly discovered, not yet
// verified) becomes 'active' or a terminal status here. Once an action reaches a
// terminal status (ratified / enacted / dropped / expired) it is frozen and no
// longer polled (its final tallies stay). Per-action failures are isolated.

import type { ProposalListRow, VotingSummary, ProposalVoteRow } from '../koios/client.js';
import {
  getStaleSyncableActions,
  updateGovernanceTallyAndStatus,
  getActionsNeedingVotedPower,
  updateVotedPower,
  getActionsNeedingVoteBackfill,
  markVotesSynced,
  type GovernanceAction,
  type GovernanceTally,
} from '../db/governance.js';
import { upsertVotes, type VoteInput } from '../db/drepVotes.js';

// Max actions a single tally/vote run processes when the caller does not specify
// one. Koios is latency-limited under a large burst (proposal_voting_summary and
// proposal_votes 504/time out), so a run stays small and stale-first ordering
// drains the backlog over several runs.
const DEFAULT_TALLY_LIMIT = 25;
const DEFAULT_VOTE_LIMIT = 25;

export interface TallySyncResult {
  active: number;
  updated: number;
  frozen: number;
  failed: number;
}

export interface VoteSyncResult {
  actions: number;
  votes: number;
  failed: number;
}

export interface TallySyncDeps {
  koios: {
    proposalList(limit?: number): Promise<ProposalListRow[]>;
    proposalVotingSummary(proposalId: string): Promise<VotingSummary | null>;
  };
  db: D1Database;
  currentEpoch: number | null;
  now: number;
  /** Max actions to tally this run. Bounds the Koios burst; defaults to DEFAULT_TALLY_LIMIT. */
  limit?: number;
  /** Delay between per-action Koios calls (ms) so a run does not burst Koios. Default 0. */
  paceMs?: number;
}

export interface VoteSyncDeps {
  koios: { proposalVotes(proposalId: string, limit?: number, offset?: number): Promise<ProposalVoteRow[]> };
  db: D1Database;
  now: number;
  /** Max actions to vote-sync this run. Bounds the Koios burst; defaults to DEFAULT_VOTE_LIMIT. */
  limit?: number;
  /** Delay between actions (ms) so a run does not burst Koios. Default 0. */
  paceMs?: number;
}

// Koios pages proposal_votes at 1000 rows; loop while a full page comes back.
const VOTES_PAGE = 1000;

/**
 * Derives the lifecycle status from the proposal_list epoch fields, falling back
 * to an expiry check against the current epoch. A terminal status freezes the action.
 */
export function deriveStatus(
  life: ProposalListRow | undefined,
  ga: GovernanceAction,
  currentEpoch: number | null,
): string {
  // Info actions have no on-chain effect: they can never be ratified or enacted,
  // so when their voting window ends they are 'closed', not 'expired'/'dropped'.
  const isInfo = ga.type === 'InfoAction';
  if (life?.enacted_epoch != null) return 'enacted';
  if (life?.ratified_epoch != null) return 'ratified';
  // A timed-out action is marked expired, then removed (dropped) the next epoch,
  // so most carry BOTH epochs; expiry is the real outcome and wins over dropped.
  // 'dropped' alone means pruned WITHOUT expiring (e.g. a sibling action was enacted).
  if (life?.expired_epoch != null) return isInfo ? 'closed' : 'expired';
  if (life?.dropped_epoch != null) return isInfo ? 'closed' : 'dropped';
  const expiry = ga.expiryEpoch ?? life?.expiration ?? null;
  if (expiry != null && currentEpoch != null && currentEpoch > expiry) return isInfo ? 'closed' : 'expired';
  return 'active';
}

/** Sums the active DRep voting power (lovelace) that voted, from the summary.
    Null when there is no summary or the power fields are absent (older Koios). */
function votedPower(s: VotingSummary | null): number | null {
  if (!s) return null;
  const yes = s.drep_active_yes_vote_power;
  const no = s.drep_active_no_vote_power;
  const abstain = s.drep_active_abstain_vote_power;
  if (yes == null && no == null && abstain == null) return null;
  return (yes == null ? 0 : Number(yes)) + (no == null ? 0 : Number(no)) + (abstain == null ? 0 : Number(abstain));
}

/** Maps a Koios voting summary onto the tally-update fields (null-tolerant). */
function tallyFields(s: VotingSummary | null): GovernanceTally {
  return {
    drepYes: s?.drep_yes_votes_cast ?? null,
    drepNo: s?.drep_no_votes_cast ?? null,
    drepAbstain: s?.drep_abstain_votes_cast ?? null,
    spoYes: s?.pool_yes_votes_cast ?? null,
    spoNo: s?.pool_no_votes_cast ?? null,
    spoAbstain: s?.pool_abstain_votes_cast ?? null,
    ccYes: s?.committee_yes_votes_cast ?? null,
    ccNo: s?.committee_no_votes_cast ?? null,
    ccAbstain: s?.committee_abstain_votes_cast ?? null,
    drepYesPct: s?.drep_yes_pct ?? null,
    drepNoPct: s?.drep_no_pct ?? null,
    spoYesPct: s?.pool_yes_pct ?? null,
    spoNoPct: s?.pool_no_pct ?? null,
    ccYesPct: s?.committee_yes_pct ?? null,
    ccNoPct: s?.committee_no_pct ?? null,
    drepVotedPower: votedPower(s),
    tallyEpoch: s?.epoch_no ?? null,
  };
}

export async function syncGovernanceTallies(deps: TallySyncDeps): Promise<TallySyncResult> {
  const { koios, db, currentEpoch, now, limit = DEFAULT_TALLY_LIMIT, paceMs = 0 } = deps;

  // Stale-first + capped: never-synced actions go first, so the backlog drains
  // over several runs instead of the same front rows being re-synced each time.
  const active = await getStaleSyncableActions(db, limit);
  if (active.length === 0) return { active: 0, updated: 0, frozen: 0, failed: 0 };

  // One proposal_list read gives lifecycle epochs for every action this cycle.
  const lifecycle = new Map<string, ProposalListRow>();
  for (const p of await koios.proposalList()) {
    lifecycle.set(`${p.proposal_tx_hash}#${p.proposal_index}`, p);
  }

  let updated = 0;
  let frozen = 0;
  let failed = 0;

  for (const [i, ga] of active.entries()) {
    // Space out the Koios calls so a run does not hammer proposal_voting_summary
    // (a heavy aggregation that 504s under a burst). No delay before the first.
    if (paceMs > 0 && i > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    try {
      const life = lifecycle.get(ga.id);
      const status = deriveStatus(life, ga, currentEpoch);
      const summary = ga.proposalId ? await koios.proposalVotingSummary(ga.proposalId) : null;

      // The epoch the action was decided: the terminal lifecycle epoch, falling
      // back to the expiry epoch when status was derived from the expiry check.
      const decidedEpoch =
        life?.enacted_epoch ?? life?.ratified_epoch ?? life?.expired_epoch ?? life?.dropped_epoch ??
        (status !== 'active' ? ga.expiryEpoch ?? life?.expiration ?? null : null);

      await updateGovernanceTallyAndStatus(db, {
        id: ga.id,
        status,
        ...tallyFields(summary),
        decidedEpoch,
        tallySyncedAt: now,
        now,
      });

      updated++;
      if (status !== 'active') frozen++;
    } catch (err) {
      // Isolated per-action failure (commonly a Koios 504/timeout). Log it instead
      // of swallowing silently, so a recurring failure is visible in the cron logs.
      failed++;
      console.warn(`[gov-tally] action ${ga.id} failed:`, err);
    }
  }

  return { active: active.length, updated, frozen, failed };
}

export interface VotedPowerBackfillResult {
  scanned: number;
  updated: number;
  failed: number;
}

export interface VotedPowerBackfillDeps {
  koios: { proposalVotingSummary(proposalId: string): Promise<VotingSummary | null> };
  db: D1Database;
  /** Max actions to backfill this run (bounds Koios calls per cron tick). */
  limit: number;
}

/**
 * One-time, self-limiting backfill: fills drep_voted_power for terminal actions
 * that predate the column, by re-reading only the Koios voting summary (no status
 * change). Once an action is filled it drops out of the candidate set.
 */
export async function backfillVotedPower(deps: VotedPowerBackfillDeps): Promise<VotedPowerBackfillResult> {
  const { koios, db, limit } = deps;
  const candidates = await getActionsNeedingVotedPower(db, limit);
  let updated = 0;
  let failed = 0;
  for (const ga of candidates) {
    if (!ga.proposalId) continue;
    try {
      const summary = await koios.proposalVotingSummary(ga.proposalId);
      const vp = votedPower(summary);
      if (vp != null) {
        await updateVotedPower(db, ga.id, vp);
        updated++;
      }
    } catch (err) {
      failed++;
      console.warn(`[gov-backfill] action ${ga.id} failed:`, err);
    }
  }
  return { scanned: candidates.length, updated, failed };
}

export async function syncGovernanceVotes(deps: VoteSyncDeps): Promise<VoteSyncResult> {
  const { koios, db, now, limit = DEFAULT_VOTE_LIMIT, paceMs = 0 } = deps;

  // Same bounded, stale-first strategy as the tally sync: proposal_votes is even
  // heavier (paginated per action), so a run must not fetch every action at once.
  // Ordering is by tally recency (vote sync has no dedicated timestamp); in steady
  // state the active set fits under the limit, so every action is covered each run.
  const active = await getStaleSyncableActions(db, limit);
  let votes = 0;
  let failed = 0;
  let actions = 0;

  for (const [i, ga] of active.entries()) {
    if (!ga.proposalId) continue;
    if (paceMs > 0 && i > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    actions++;
    try {
      const collected: VoteInput[] = [];
      for (let offset = 0; ; offset += VOTES_PAGE) {
        const page = await koios.proposalVotes(ga.proposalId, VOTES_PAGE, offset);
        for (const v of page) {
          collected.push({ voterRole: v.voter_role, voterId: v.voter_id, voterHex: v.voter_hex ?? null, vote: v.vote, metaUrl: v.meta_url ?? null, blockTime: v.block_time ?? null });
        }
        if (page.length < VOTES_PAGE) break;
      }
      votes += await upsertVotes(db, ga.id, collected, now);
      await markVotesSynced(db, ga.id, now);
    } catch (err) {
      failed++;
      console.warn(`[gov-votes] action ${ga.id} failed:`, err);
    }
  }

  return { actions, votes, failed };
}

export interface VoteBackfillResult { actions: number; votes: number; failed: number; }

/**
 * One-time, self-limiting backfill of per-voter vote lists for finalised actions
 * that predate our vote sync (votes_synced_at IS NULL). Pulls proposal_votes once
 * per action (the lists are immutable after finalisation), upserts, and marks the
 * action synced so it drops out of the candidate set. Bounded by `limit`.
 */
export async function backfillFinalizedVotes(deps: VoteSyncDeps): Promise<VoteBackfillResult> {
  const { koios, db, now, limit = DEFAULT_VOTE_LIMIT, paceMs = 0 } = deps;
  const candidates = await getActionsNeedingVoteBackfill(db, limit);
  let votes = 0;
  let failed = 0;
  let actions = 0;
  for (const [i, ga] of candidates.entries()) {
    if (!ga.proposalId) continue;
    if (paceMs > 0 && i > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    actions++;
    try {
      const collected: VoteInput[] = [];
      for (let offset = 0; ; offset += VOTES_PAGE) {
        const page = await koios.proposalVotes(ga.proposalId, VOTES_PAGE, offset);
        for (const v of page) {
          collected.push({ voterRole: v.voter_role, voterId: v.voter_id, voterHex: v.voter_hex ?? null, vote: v.vote, metaUrl: v.meta_url ?? null, blockTime: v.block_time ?? null });
        }
        if (page.length < VOTES_PAGE) break;
      }
      votes += await upsertVotes(db, ga.id, collected, now);
      await markVotesSynced(db, ga.id, now);
    } catch (err) {
      failed++;
      console.warn(`[gov-votes-backfill] action ${ga.id} failed:`, err);
    }
  }
  return { actions, votes, failed };
}
