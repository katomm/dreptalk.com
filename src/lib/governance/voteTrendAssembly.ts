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
}

export interface TrendAssemblyResult {
  window: { start: number; end: number };
  /** Final CC yes-vote count, for a caller's own "N of M" label. */
  ccYesCount: number;
  ccSize: number;
  /** thresholdPct is left null and finalLabel left '' here; callers layer both on top. */
  inputs: TrendBodyInput[];
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
  const windowStart = action.submittedEpoch != null ? epochStartUnix(action.submittedEpoch, cfg) : null;
  const windowEnd = decidedEpoch != null ? epochStartUnix(decidedEpoch, cfg) : null;
  const voteTimes = [...trendRows.map((r) => r.block_time), ...ccVotes.map((v) => v.blockTime ?? 0)].filter((t) => t > 0);
  const start = windowStart ?? (voteTimes.length ? Math.min(...voteTimes) : 0);
  const end = windowEnd && windowEnd > start ? windowEnd : (voteTimes.length ? Math.max(...voteTimes) : start + 1);

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

  return { window: { start, end }, ccYesCount: ccYes.length, ccSize, inputs };
}
