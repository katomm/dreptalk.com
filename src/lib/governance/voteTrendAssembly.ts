// Shared pure assembly of the voting-trend window and per-body inputs, used by both
// the History-tab full chart (VotingTrendChart.astro) and the sidebar teaser
// sparkline (t/[slug].astro miniChart). Kept in one place so the two never diverge:
// each caller layers its own thresholdPct/finalLabel on top of the returned inputs
// (the full chart adds threshold lines and percent/"N of M" labels, the teaser adds
// neither).
import type { GovernanceAction } from '@/lib/db/governance.js';
import type { TrendVoteRow } from '@/lib/db/drepVotes.js';
import type { CcVote } from '@/lib/koios/corrections.js';
import { ccFinalVotesByMember } from '@/lib/koios/corrections.js';
import type { CommitteeMemberTerm } from '@/lib/koios/committeeTimeline.js';
import { activeCommitteeSizeAt } from '@/lib/koios/committeeTimeline.js';
import { epochStartUnix, type NetworkConfig } from '@/lib/config/network.js';
import type { TrendBodyInput } from '@/lib/governance/voteTrend.js';

export interface TrendAssemblyInputs {
  action: Pick<GovernanceAction, 'submittedEpoch' | 'expiryEpoch' | 'decidedEpoch' | 'drepYesPct' | 'spoYesPct' | 'ccYesPct'>;
  trendRows: TrendVoteRow[];
  ccVotes: CcVote[];
  committee: { members: CommitteeMemberTerm[]; hotToCold: Map<string, string> };
  cfg: NetworkConfig;
  /** Current time in unix seconds. When set, an action still in its voting window
      stops at now instead of running flat to its future expiry epoch. Omit to not cap. */
  nowSec?: number;
}

export interface TrendAssemblyResult {
  /** Full voting window, for the chart x-axis domain (start to expiry/decision epoch). */
  window: { start: number; end: number };
  /** Where the line stops: min(window.end, now). Equals window.end for terminal actions. */
  lineEnd: number;
  /** Final CC yes-vote count, for a caller's own "N of M" label. */
  ccYesCount: number;
  ccSize: number;
  /** thresholdPct is left null and finalLabel left '' here; callers layer both on top. */
  inputs: TrendBodyInput[];
}

/**
 * The epoch at whose start voting on a terminal action ended: the decision epoch,
 * clamped to the expiry epoch. An enacted action's decision epoch can be its
 * enactment epoch, one past the expiry, but voting still ended at the start of the
 * expiry epoch. Shared by the chart window and the compare picker's end labels so
 * both always name the same epoch.
 */
export function votingEndEpoch(decidedEpoch: number | null, expiryEpoch: number | null): number | null {
  const decided = decidedEpoch ?? expiryEpoch;
  return decided != null && expiryEpoch != null ? Math.min(decided, expiryEpoch) : decided;
}

/**
 * Builds the voting window and per-body TrendBodyInput[] shared by every voting-trend
 * chart. DRep/SPO are power-weighted yes votes (voted_power); CC is the committee-
 * timeline-deduped final vote per active member, weighted 1 each.
 */
export function assembleTrendInputs(a: TrendAssemblyInputs): TrendAssemblyResult {
  const { action, trendRows, ccVotes, committee, cfg } = a;

  // Voting window in unix seconds: from the submit epoch start to the decision (or
  // expiry) epoch start. Falls back to the span of observed votes when epochs are absent.
  const decidedEpoch = action.decidedEpoch ?? action.expiryEpoch;
  // Clamped to expiry (see votingEndEpoch): unclamped, a compared action drew one
  // epoch of window that never existed and pushed the shared compare axis past
  // every real deadline.
  const windowEndEpoch = votingEndEpoch(action.decidedEpoch, action.expiryEpoch);
  const windowStart = action.submittedEpoch != null ? epochStartUnix(action.submittedEpoch, cfg) : null;
  const windowEnd = windowEndEpoch != null ? epochStartUnix(windowEndEpoch, cfg) : null;
  const voteTimes = [...trendRows.map((r) => r.block_time), ...ccVotes.map((v) => v.blockTime ?? 0)].filter((t) => t > 0);
  const start = windowStart ?? (voteTimes.length ? Math.min(...voteTimes) : 0);
  // The x-axis spans the whole voting window (up to the expiry/decision epoch), so the
  // deadline stays visible on the right.
  const end = windowEnd && windowEnd > start ? windowEnd : (voteTimes.length ? Math.max(...voteTimes) : start + 1);
  // The line itself stops at "now": while an action is still in its voting window the
  // end epoch is in the future, and running the line flat to that future edge reads as
  // if voting were done. Capping the series (not the axis) leaves the remaining window
  // empty on the right instead. Terminal actions are unaffected (end is already past).
  const lineEnd = a.nowSec != null ? Math.max(start + 1, Math.min(end, a.nowSec)) : end;

  // DRep + SPO yes votes weighted by voted_power.
  const yesByRole = (role: string) =>
    trendRows.filter((r) => r.voter_role === role && r.vote === 'Yes' && r.voted_power != null)
      .map((r) => ({ blockTime: r.block_time, weight: r.voted_power as number }));

  // CC yes votes: dedup to one final vote per active member, weight 1 each.
  const ratifiedEpoch = decidedEpoch ?? 0;
  const ccFinal = decidedEpoch != null
    ? ccFinalVotesByMember(ccVotes, committee.members, committee.hotToCold, ratifiedEpoch)
    : [];
  const ccYes = ccFinal.filter((m) => m.vote === 'Yes').map((m) => ({ blockTime: m.blockTime, weight: 1 }));
  const ccSize = decidedEpoch != null ? activeCommitteeSizeAt(committee.members, ratifiedEpoch) : 0;

  const inputs: TrendBodyInput[] = [
    { key: 'DRep', yesVotes: yesByRole('DRep'), finalPct: action.drepYesPct, thresholdPct: null, finalLabel: '' },
    { key: 'SPO', yesVotes: yesByRole('SPO'), finalPct: action.spoYesPct, thresholdPct: null, finalLabel: '' },
    { key: 'CC', yesVotes: ccYes, finalPct: action.ccYesPct, thresholdPct: null, finalLabel: '' },
  ];

  return { window: { start, end }, lineEnd, ccYesCount: ccYes.length, ccSize, inputs };
}
