// Tally + lifecycle sync for governance actions that are not yet finalized
// (status 'active' or 'pending'). Each cycle, for every such action: fetch its
// power-weighted vote summary, derive its lifecycle status from the proposal_list
// epoch fields, and persist both. A 'pending' action (freshly discovered, not yet
// verified) becomes 'active' or a terminal status here. Once an action reaches a
// terminal status (ratified / enacted / dropped / expired) it is frozen and no
// longer polled (its final tallies stay). Per-action failures are isolated.

import type { ProposalListRow, VotingSummary, ProposalVoteRow } from '../koios/client.js';
import {
  getSyncableGovernanceActions,
  updateGovernanceTallyAndStatus,
  type GovernanceAction,
  type GovernanceTally,
} from '../db/governance.js';
import { upsertVotes, type VoteInput } from '../db/drepVotes.js';

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
}

export interface VoteSyncDeps {
  koios: { proposalVotes(proposalId: string, limit?: number, offset?: number): Promise<ProposalVoteRow[]> };
  db: D1Database;
  now: number;
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
  if (life?.enacted_epoch != null) return 'enacted';
  if (life?.ratified_epoch != null) return 'ratified';
  // An action that times out is marked expired, then removed (dropped) from the
  // proposal set the next epoch, so most expired actions carry BOTH epochs.
  // Expiry is the meaningful outcome, so it wins; 'dropped' alone means the action
  // was pruned WITHOUT expiring (e.g. a competing action of the same type was enacted).
  if (life?.expired_epoch != null) return 'expired';
  if (life?.dropped_epoch != null) return 'dropped';
  const expiry = ga.expiryEpoch ?? life?.expiration ?? null;
  if (expiry != null && currentEpoch != null && currentEpoch > expiry) return 'expired';
  return 'active';
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
    tallyEpoch: s?.epoch_no ?? null,
  };
}

export async function syncGovernanceTallies(deps: TallySyncDeps): Promise<TallySyncResult> {
  const { koios, db, currentEpoch, now } = deps;

  const active = await getSyncableGovernanceActions(db);
  if (active.length === 0) return { active: 0, updated: 0, frozen: 0, failed: 0 };

  // One proposal_list read gives lifecycle epochs for every action this cycle.
  const lifecycle = new Map<string, ProposalListRow>();
  for (const p of await koios.proposalList()) {
    lifecycle.set(`${p.proposal_tx_hash}#${p.proposal_index}`, p);
  }

  let updated = 0;
  let frozen = 0;
  let failed = 0;

  for (const ga of active) {
    try {
      const status = deriveStatus(lifecycle.get(ga.id), ga, currentEpoch);
      const summary = ga.proposalId ? await koios.proposalVotingSummary(ga.proposalId) : null;

      await updateGovernanceTallyAndStatus(db, {
        id: ga.id,
        status,
        ...tallyFields(summary),
        tallySyncedAt: now,
        now,
      });

      updated++;
      if (status !== 'active') frozen++;
    } catch {
      failed++;
    }
  }

  return { active: active.length, updated, frozen, failed };
}

export async function syncGovernanceVotes(deps: VoteSyncDeps): Promise<VoteSyncResult> {
  const { koios, db, now } = deps;

  const active = await getSyncableGovernanceActions(db);
  let votes = 0;
  let failed = 0;
  let actions = 0;

  for (const ga of active) {
    if (!ga.proposalId) continue;
    actions++;
    try {
      const collected: VoteInput[] = [];
      for (let offset = 0; ; offset += VOTES_PAGE) {
        const page = await koios.proposalVotes(ga.proposalId, VOTES_PAGE, offset);
        for (const v of page) {
          collected.push({ voterRole: v.voter_role, voterId: v.voter_id, voterHex: v.voter_hex ?? null, vote: v.vote });
        }
        if (page.length < VOTES_PAGE) break;
      }
      votes += await upsertVotes(db, ga.id, collected, now);
    } catch {
      failed++;
    }
  }

  return { actions, votes, failed };
}
