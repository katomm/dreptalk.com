// Pure view models for vote-change analytics. drep_vote_history archives every
// superseded vote, including anchor-only re-votes where the choice stood, so a
// voter with history did NOT necessarily change their vote. The honest primitive
// everywhere here is the NET position change, the voter's first recorded vote
// compared with their current one. History pairs without a live current vote
// (sweep-sourced archives of voters missing from drep_votes) are unclassifiable
// and are counted separately, never folded into either bucket.
import { formatAdaCompact } from '../format/ada.js';
import type { VoteChangeRow } from '../db/voteChangeStats.js';

export interface ActionVoteChanges {
  /** Voters whose current vote differs from their first recorded one. */
  changed: number;
  /** Voters with history whose position never changed net. */
  samePosition: number;
  toYes: number;
  toNo: number;
  toAbstain: number;
  /** Sum of the changed voters' current voted power, null unless every one has a reading. */
  movedPower: bigint | null;
  /** History entries with no live current vote to compare against. */
  unclassified: number;
}

export interface VoteChangeTopAction {
  gaId: string;
  title: string;
  href: string | null;
  type: string;
  decidedEpoch: number;
  changedCount: number;
}

export interface VoteChangeView {
  decidedSwept: number;
  actionsWithChange: number;
  changedCount: number;
  samePositionCount: number;
  toYes: number;
  toNo: number;
  toAbstain: number;
  topActions: VoteChangeTopAction[];
  decidedUnswept: number;
  orphanPairs: number;
}

/** Net classification, earliest recorded vote vs the current one. */
export function classifyNetChange(
  historyNewestFirst: { vote: string }[],
  currentVote: string,
): 'changed' | 'same' {
  const first = historyNewestFirst[historyNewestFirst.length - 1];
  return first && first.vote !== currentVote ? 'changed' : 'same';
}

function bumpDirection(c: { toYes: number; toNo: number; toAbstain: number }, vote: string): void {
  if (vote === 'Yes') c.toYes += 1;
  else if (vote === 'No') c.toNo += 1;
  else if (vote === 'Abstain') c.toAbstain += 1;
}

export function buildActionVoteChanges(
  voteHistory: Map<string, { vote: string; voter_role: string; block_time: number }[]>,
  currentVotes: Map<string, { role: string; vote: string; voted_power?: number | null }>,
  role: 'DRep' | 'SPO',
): ActionVoteChanges {
  const c: ActionVoteChanges = {
    changed: 0, samePosition: 0, toYes: 0, toNo: 0, toAbstain: 0,
    movedPower: 0n, unclassified: 0,
  };
  let powerComplete = true;
  for (const [voterId, history] of voteHistory) {
    if (history.length === 0 || history[0].voter_role !== role) continue;
    const current = currentVotes.get(voterId);
    if (!current) {
      c.unclassified += 1;
      continue;
    }
    if (classifyNetChange(history, current.vote) === 'changed') {
      c.changed += 1;
      bumpDirection(c, current.vote);
      if (current.voted_power == null) powerComplete = false;
      else c.movedPower = (c.movedPower ?? 0n) + BigInt(current.voted_power);
    } else {
      c.samePosition += 1;
    }
  }
  if (!powerComplete || c.changed === 0) c.movedPower = null;
  return c;
}

/**
 * One-sentence summary for the action page, direction counts, plus the moved
 * power when every changed voter has a reading. Null when nothing changed.
 */
export function describeActionVoteChanges(c: ActionVoteChanges): string | null {
  if (c.changed === 0) return null;
  const parts: string[] = [];
  if (c.toYes > 0) parts.push(`${c.toYes} to yes`);
  if (c.toNo > 0) parts.push(`${c.toNo} to no`);
  if (c.toAbstain > 0) parts.push(`${c.toAbstain} to abstain`);
  const power =
    c.movedPower !== null ? `, together holding ${formatAdaCompact(c.movedPower.toString())} of voting power` : '';
  return `Changed votes: ${parts.join(', ')}${power}.`;
}

export function buildVoteChangeView(
  rows: VoteChangeRow[],
  counts: { decidedSwept: number; decidedUnswept: number; orphanPairs: number },
): VoteChangeView {
  const view: VoteChangeView = {
    decidedSwept: counts.decidedSwept,
    actionsWithChange: 0,
    changedCount: 0,
    samePositionCount: 0,
    toYes: 0, toNo: 0, toAbstain: 0,
    topActions: [],
    decidedUnswept: counts.decidedUnswept,
    orphanPairs: counts.orphanPairs,
  };
  const perAction = new Map<string, VoteChangeTopAction>();
  for (const r of rows) {
    if (r.firstVote === r.currentVote) {
      view.samePositionCount += 1;
      continue;
    }
    view.changedCount += 1;
    bumpDirection(view, r.currentVote);
    const entry = perAction.get(r.gaId);
    if (entry) entry.changedCount += 1;
    else
      perAction.set(r.gaId, {
        gaId: r.gaId,
        title: r.title ?? r.type,
        href: r.topicSlug != null ? `/t/${r.topicSlug}/` : null,
        type: r.type,
        decidedEpoch: r.decidedEpoch,
        changedCount: 1,
      });
  }
  view.actionsWithChange = perAction.size;
  view.topActions = [...perAction.values()]
    .sort((a, b) => b.changedCount - a.changedCount || a.gaId.localeCompare(b.gaId))
    .slice(0, 5);
  return view;
}
