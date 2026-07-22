// Tally + lifecycle sync for governance actions that are not yet finalized
// (status 'active' or 'pending'). Each cycle, for every such action: fetch its
// power-weighted vote summary, derive its lifecycle status from the proposal_list
// epoch fields, and persist both. A 'pending' action (freshly discovered, not yet
// verified) becomes 'active' or a terminal status here. Once an action reaches a
// terminal status (enacted / dropped / expired / closed) it is frozen and no
// longer polled (its final tallies stay). 'ratified' is the exception: Koios sets
// enacted_epoch ~1 epoch after ratified_epoch, so a ratified row keeps getting a
// lightweight, status-only lifecycle re-check (no tally re-fetch) until it flips
// to enacted. Per-action failures are isolated.

import type { ProposalListRow, VotingSummary, ProposalVoteRow, VoteListRow } from '../koios/client.js';
import { spoTallyPct, spoEligiblePower } from '../koios/corrections.js';
import {
  getStaleSyncableActions,
  getVoteStaleSyncableActions,
  getRatifiedActions,
  updateGovernanceTallyAndStatus,
  updateGovernanceActionStatus,
  getActionsNeedingVotedPower,
  updateVotedPower,
  getActionsNeedingVoteBackfill,
  markVotesSynced,
  getGovStatusEventsForTimeFix,
  updateActivityCreatedAt,
  type GovernanceAction,
  type GovernanceTally,
} from '../db/governance.js';
import { upsertVotes, markStalePendingVotesFailed, getVotesNeedingMetaHash, setVoteMetaHash, type VoteInput } from '../db/drepVotes.js';
import { insertGovStatusEventIfNew } from '../db/activity.js';
import { isTerminalStatus } from './view.js';
import { epochStartMs, resolveNetwork, type CardanoNetwork } from '../config/network.js';

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
  /** Ratified rows advanced to a later terminal status (usually 'enacted') this run. */
  reSynced: number;
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
  /** Network, for dating a gov_status feed event at its on-chain epoch boundary
      (epochStartMs(decidedEpoch)) instead of detection time. Falls back to `now`
      when absent (keeps older callers/tests working). */
  network?: CardanoNetwork;
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
  /** Max vote pages to fetch per action; defaults to MAX_VOTE_PAGES. Tests lower it. */
  maxPages?: number;
}

// Koios pages proposal_votes at 1000 rows; loop while a full page comes back.
const VOTES_PAGE = 1000;

// Hard cap on vote pages fetched per action per run. Without it the pagination
// loop is unbounded: an action whose vote list keeps returning full pages (real
// abuse on a testnet, or a paginating Koios that never ends) makes the cron
// worker run out of CPU/subrequests and get killed mid-run, before it can mark
// the action synced, so the same action kills every subsequent run too. The cap
// (25k votes) sits far above any realistic on-chain action; only a pathological
// list is truncated, and that is logged.
const MAX_VOTE_PAGES = 25;

/**
 * Fetches a proposal's per-voter votes, bounded to maxPages pages. Returns the
 * collected votes and whether the cap was hit (the list was longer and got
 * truncated). Shared by the live vote sync and the finalised backfill.
 */
async function collectProposalVotes(
  koios: VoteSyncDeps['koios'],
  proposalId: string,
  maxPages: number,
): Promise<{ votes: VoteInput[]; capped: boolean }> {
  const votes: VoteInput[] = [];
  let capped = true;
  for (let page = 0; page < maxPages; page++) {
    const rows = await koios.proposalVotes(proposalId, VOTES_PAGE, page * VOTES_PAGE);
    for (const v of rows) {
      votes.push({
        voterRole: v.voter_role,
        voterId: v.voter_id,
        voterHex: v.voter_hex ?? null,
        vote: v.vote,
        metaUrl: v.meta_url ?? null,
        metaHash: v.meta_hash ?? null,
        blockTime: v.block_time ?? null,
      });
    }
    if (rows.length < VOTES_PAGE) {
      capped = false;
      break;
    }
  }
  return { votes, capped };
}

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
  // An action expires AT the start of its expiration epoch (on-chain expired_epoch
  // === expiration; votes count only through the end of epoch expiration - 1), so
  // currentEpoch === expiry already means decided: use >=, not >.
  if (expiry != null && currentEpoch != null && currentEpoch >= expiry) return isInfo ? 'closed' : 'expired';
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

/** Parses a Koios lovelace power string to a number; null when absent. The
    magnitudes (up to ~2.1e16) exceed Number.MAX_SAFE_INTEGER, but the lost
    precision is in the lowest lovelace and irrelevant to a 2-decimal percentage
    (same trade-off as votedPower above). */
function powerNum(v: string | null | undefined): number | null {
  return v == null ? null : Number(v);
}

/** Per-option vote power (lovelace) for the sidebar breakdown. All buckets are the
    clean active yes/no/abstain that were actually cast; non-voting default stake is
    excluded (that lives in the pool_no_vote_power / pool_passive_* fields, used only by
    the HardForkInitiation pct recompute). Null-tolerant for older Koios without power fields. */
export function votePowers(s: VotingSummary | null) {
  return {
    drepYesPower: powerNum(s?.drep_active_yes_vote_power),
    drepNoPower: powerNum(s?.drep_active_no_vote_power),
    drepAbstainPower: powerNum(s?.drep_active_abstain_vote_power),
    spoYesPower: powerNum(s?.pool_active_yes_vote_power),
    spoNoPower: powerNum(s?.pool_active_no_vote_power),
    spoAbstainPower: powerNum(s?.pool_active_abstain_vote_power),
  };
}

/** Maps a Koios voting summary onto the tally-update fields (null-tolerant). */
function tallyFields(s: VotingSummary | null): GovernanceTally {
  const spo = s ? spoTallyPct(s) : null;
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
    ...votePowers(s),
    spoEligiblePower: spoEligiblePower(s),
    drepYesPct: s?.drep_yes_pct ?? null,
    drepNoPct: s?.drep_no_pct ?? null,
    spoYesPct: spo?.yesPct ?? null,
    spoNoPct: spo?.noPct ?? null,
    ccYesPct: s?.committee_yes_pct ?? null,
    ccNoPct: s?.committee_no_pct ?? null,
    drepVotedPower: votedPower(s),
    tallyEpoch: s?.epoch_no ?? null,
  };
}

export async function syncGovernanceTallies(deps: TallySyncDeps): Promise<TallySyncResult> {
  const { koios, db, currentEpoch, now, network, limit = DEFAULT_TALLY_LIMIT, paceMs = 0 } = deps;

  // A status change's feed time is its on-chain boundary (start of the decided
  // epoch), not when this sync noticed it: a backlog catch-up can detect a months-
  // old enactment, and "now" would wrongly float it to the top of the feed. Falls
  // back to `now` when the network (or the decided epoch) is unknown.
  const cfg = network ? resolveNetwork(network) : null;
  const statusEventTime = (decidedEpoch: number | null): number =>
    cfg && decidedEpoch != null ? epochStartMs(decidedEpoch, cfg) : now;

  // Stale-first + capped: never-synced actions go first, so the backlog drains
  // over several runs instead of the same front rows being re-synced each time.
  const active = await getStaleSyncableActions(db, limit);
  // Ratified rows are not frozen: they need a status-only re-check until enacted
  // (see getRatifiedActions). Fetched up front so one proposal_list read serves
  // both passes and the re-check still runs on a tick with no active actions.
  const ratified = await getRatifiedActions(db, limit);
  if (active.length === 0 && ratified.length === 0) {
    return { active: 0, updated: 0, frozen: 0, failed: 0, reSynced: 0 };
  }

  // One proposal_list read gives lifecycle epochs for every action this cycle.
  const lifecycle = new Map<string, ProposalListRow>();
  for (const p of await koios.proposalList()) {
    lifecycle.set(`${p.proposal_tx_hash}#${p.proposal_index}`, p);
  }

  let updated = 0;
  let frozen = 0;
  let failed = 0;
  let reSynced = 0;

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

      // Only a transition INTO a terminal outcome (enacted/expired/dropped/...) is
      // a feed event. pending -> active is suppressed: on-chain an action is votable
      // from submission, so "moved to voting" right after "new governance action" is
      // just our two-phase sync (discover, then tally) settling, not a milestone. A
      // same-status tally refresh emits nothing either. created_at is the on-chain
      // boundary of the decided epoch (statusEventTime), not detection time.
      if (status !== ga.status && isTerminalStatus(status) && ga.topicId) {
        await insertGovStatusEventIfNew(db, {
          topicId: ga.topicId,
          from: ga.status,
          to: status,
          createdAt: statusEventTime(decidedEpoch),
        });
      }

      updated++;
      if (status !== 'active') frozen++;
    } catch (err) {
      // Isolated per-action failure (commonly a Koios 504/timeout). Log it instead
      // of swallowing silently, so a recurring failure is visible in the cron logs.
      failed++;
      console.warn(`[gov-tally] action ${ga.id} failed:`, err);
    }
  }

  // Lifecycle re-check for ratified rows: re-derive status from the shared
  // proposal_list and advance the row when Koios has since set enacted_epoch
  // (or another terminal epoch). Status-only via updateGovernanceActionStatus,
  // so the already-final tally and per-voter votes are left untouched. Skips a
  // row absent from this run's proposal_list (no fresh lifecycle => don't guess)
  // or still genuinely ratified (enacted_epoch not set yet).
  for (const ga of ratified) {
    try {
      const life = lifecycle.get(ga.id);
      if (!life) continue;
      const status = deriveStatus(life, ga, currentEpoch);
      if (status === ga.status) continue;
      const decidedEpoch =
        life.enacted_epoch ?? life.ratified_epoch ?? life.expired_epoch ?? life.dropped_epoch ?? ga.decidedEpoch ?? null;
      await updateGovernanceActionStatus(db, { id: ga.id, status, decidedEpoch, now });
      // Enactment (ratified -> enacted) is itself a feed milestone, mirroring the
      // active-loop rule: a transition into a terminal status with a topic emits one.
      // Dated at the enacted-epoch boundary (statusEventTime), not detection time,
      // so a backlog catch-up does not float a weeks-old enactment to "just now".
      if (isTerminalStatus(status) && ga.topicId) {
        await insertGovStatusEventIfNew(db, {
          topicId: ga.topicId,
          from: ga.status,
          to: status,
          createdAt: statusEventTime(decidedEpoch),
        });
      }
      reSynced++;
    } catch (err) {
      failed++;
      console.warn(`[gov-tally] ratified re-check ${ga.id} failed:`, err);
    }
  }

  return { active: active.length, updated, frozen, failed, reSynced };
}

export interface GovStatusTimeBackfillResult {
  scanned: number;
  updated: number;
}

export interface GovStatusTimeBackfillDeps {
  db: D1Database;
  network: CardanoNetwork;
  /** Max gov_status events to inspect this run (bounds the sweep). */
  limit: number;
}

/**
 * Self-healing backfill: re-dates gov_status feed events to their on-chain epoch
 * boundary (epochStartMs(decided_epoch)) when the stored created_at drifted from
 * it. This corrects events written at detection time before that became the epoch
 * boundary, e.g. a backlog of terminal transitions caught up in one run (which
 * would otherwise all read "just now" and crowd the feed). Only the event marking
 * the action's current terminal status is touched (see getGovStatusEventsForTimeFix).
 * Only-changed: once every event sits on its boundary this writes nothing.
 */
export async function backfillGovStatusTimes(deps: GovStatusTimeBackfillDeps): Promise<GovStatusTimeBackfillResult> {
  const { db, network, limit } = deps;
  const cfg = resolveNetwork(network);
  const candidates = await getGovStatusEventsForTimeFix(db, limit);
  let updated = 0;
  for (const e of candidates) {
    const correct = epochStartMs(e.decidedEpoch, cfg);
    if (e.createdAt !== correct) {
      await updateActivityCreatedAt(db, e.id, correct);
      updated++;
    }
  }
  return { scanned: candidates.length, updated };
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
      if (!summary) continue;
      const vp = votedPower(summary);
      const powers = votePowers(summary);
      const eligible = spoEligiblePower(summary);
      const hasData = vp != null || eligible != null || Object.values(powers).some((v) => v != null);
      if (hasData) {
        await updateVotedPower(db, ga.id, { votedPower: vp, ...powers, spoEligiblePower: eligible });
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
  const { koios, db, now, limit = DEFAULT_VOTE_LIMIT, paceMs = 0, maxPages = MAX_VOTE_PAGES } = deps;

  // Same bounded, stale-first strategy as the tally sync, but ordered by vote
  // recency (votes_synced_at): proposal_votes is even heavier (paginated per
  // action), so a run must not fetch every action at once, and ordering by its
  // own timestamp keeps an action whose vote list is stale from starving behind
  // the freshly tallied ones when the active set exceeds the per-run limit.
  const active = await getVoteStaleSyncableActions(db, limit);
  let votes = 0;
  let failed = 0;
  let actions = 0;

  for (const [i, ga] of active.entries()) {
    if (!ga.proposalId) continue;
    if (paceMs > 0 && i > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    actions++;
    try {
      const { votes: collected, capped } = await collectProposalVotes(koios, ga.proposalId, maxPages);
      votes += await upsertVotes(db, ga.id, collected, now);
      await markVotesSynced(db, ga.id, now);
      if (capped) {
        console.warn(`[gov-votes] action ${ga.id} vote list exceeds ${maxPages * VOTES_PAGE}; synced a capped prefix`);
      }
    } catch (err) {
      failed++;
      console.warn(`[gov-votes] action ${ga.id} failed:`, err);
    }
  }

  return { actions, votes, failed };
}

// A pending optimistic vote that has not been confirmed by the authoritative
// sync within this many seconds is treated as failed (tx dropped or rolled back).
export const PENDING_VOTE_TTL_SEC = 6 * 3600;

/**
 * Flags optimistic votes that never appeared on chain. Call after the
 * authoritative vote sync, so any vote that DID land has already cleared its
 * pending marker via upsertVotes.
 */
export async function reconcilePendingVotes(db: D1Database, nowSeconds: number): Promise<number> {
  return markStalePendingVotesFailed(db, nowSeconds - PENDING_VOTE_TTL_SEC);
}

export interface VoteBackfillResult { actions: number; votes: number; failed: number; }

/**
 * One-time, self-limiting backfill of per-voter vote lists for finalised actions
 * that predate our vote sync (votes_synced_at IS NULL). Pulls proposal_votes once
 * per action (the lists are immutable after finalisation), upserts, and marks the
 * action synced so it drops out of the candidate set. Bounded by `limit`.
 */
export async function backfillFinalizedVotes(deps: VoteSyncDeps): Promise<VoteBackfillResult> {
  const { koios, db, now, limit = DEFAULT_VOTE_LIMIT, paceMs = 0, maxPages = MAX_VOTE_PAGES } = deps;
  const candidates = await getActionsNeedingVoteBackfill(db, limit);
  let votes = 0;
  let failed = 0;
  let actions = 0;
  for (const [i, ga] of candidates.entries()) {
    if (!ga.proposalId) continue;
    if (paceMs > 0 && i > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    actions++;
    try {
      const { votes: collected, capped } = await collectProposalVotes(koios, ga.proposalId, maxPages);
      votes += await upsertVotes(db, ga.id, collected, now);
      // Mark synced even when capped: the prefix is stored and the action drops
      // out of the candidate set, so a pathological list cannot stall the backfill
      // on the same action every run.
      await markVotesSynced(db, ga.id, now);
      if (capped) {
        console.warn(`[gov-votes-backfill] action ${ga.id} vote list exceeds ${maxPages * VOTES_PAGE}; synced a capped prefix`);
      }
    } catch (err) {
      failed++;
      console.warn(`[gov-votes-backfill] action ${ga.id} failed:`, err);
    }
  }
  return { actions, votes, failed };
}

export interface MetaHashBackfillDeps {
  koios: { voterProposalVoteList(voterId: string, proposalId: string): Promise<VoteListRow[]> };
  db: D1Database;
  /** Max votes to backfill this run; each costs one Koios call. Defaults to DEFAULT_VOTE_LIMIT. */
  limit?: number;
  /** Delay between per-vote Koios calls (ms) so a run does not burst Koios. Default 0. */
  paceMs?: number;
}

export interface MetaHashBackfillResult {
  votes: number;
  failed: number;
}

/**
 * One-time historical backfill: fills meta_hash on votes for finalized actions
 * synced before meta_hash capture existed, so the rationale queue can pick them
 * up. Resolves each hash from /vote_list (per voter+action) rather than
 * /proposal_votes: the remaining hash-less votes were all cast by DReps that
 * later deregistered, and /proposal_votes silently omits deregistered voters,
 * so refetching it can never fill them. /vote_list keeps the full history.
 * The candidate query self-drains as hashes get filled.
 */
export async function backfillVoteMetaHashes(deps: MetaHashBackfillDeps): Promise<MetaHashBackfillResult> {
  const { koios, db, limit = DEFAULT_VOTE_LIMIT, paceMs = 0 } = deps;
  const candidates = await getVotesNeedingMetaHash(db, limit);
  let votes = 0;
  let failed = 0;
  for (const [i, c] of candidates.entries()) {
    if (paceMs > 0 && i > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
    try {
      const rows = await koios.voterProposalVoteList(c.voter_id, c.proposal_id);
      // A voter can re-vote, so the pair may have several history rows. The hash
      // must belong to the anchor URL we stored, so match on that; among re-votes
      // to the same URL prefer the stored block_time, else the newest (rows come
      // newest first). Never attach a hash from a different anchor.
      const sameUrl = rows.filter((r) => r.meta_url === c.meta_url);
      const match = (c.block_time != null && sameUrl.find((r) => r.block_time === c.block_time)) || sameUrl[0];
      if (!match?.meta_hash) {
        failed++;
        console.warn(`[gov-rationale-hash-backfill] no hash on ${c.proposal_id} for ${c.voter_id}`);
        continue;
      }
      await setVoteMetaHash(db, c.ga_id, c.voter_id, match.meta_hash);
      votes++;
    } catch (err) {
      failed++;
      console.warn(`[gov-rationale-hash-backfill] ${c.proposal_id} voter ${c.voter_id} failed:`, err);
    }
  }
  return { votes, failed };
}
