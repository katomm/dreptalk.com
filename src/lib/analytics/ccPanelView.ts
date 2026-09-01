// Pure view model for the hub's Constitutional Committee panel. Every
// per-action reading replays the exact logic the GA pages use, the same
// eligibility epoch, the same active-member set and the same final-vote
// dedup, so the hub can never disagree with an action's own Votes tab.
// Actions that cannot be resolved are skipped and disclosed, and the
// below-threshold rate only uses the frozen per-action snapshot.
import { activeCommitteeMembersAt, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import { finalCcVoteByMember } from '../koios/corrections.js';
import { committeeEpochForAction } from '../db/committee.js';
import type { CcVoteRow, DecidedCcAction } from '../db/committee.js';
import type { CcNameIndex } from '../governance/ccNames.js';
import { readThresholdSnapshot } from '../governance/thresholds.js';
import { isCcEligible } from '../governance/view.js';

export interface CcMemberRow {
  coldKeyHex: string;
  name: string | null;
  voted: number;
  eligible: number;
  pct: number;
}

export interface CcPanelView {
  considered: number;
  skipped: number;
  medianTurnoutPct: number | null;
  splitCount: number;
  belowThreshold: number;
  verdictBasis: number;
  medianLatencyDays: number | null;
  members: CcMemberRow[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function buildCcPanel(input: {
  actions: DecidedCcAction[];
  votesByAction: Map<string, CcVoteRow[]>;
  members: CommitteeMemberTerm[];
  hotToCold: Map<string, string>;
  nameIndex: CcNameIndex;
  currentEpoch: number | null;
}): CcPanelView {
  const { actions, votesByAction, members, hotToCold, nameIndex, currentEpoch } = input;
  let considered = 0;
  let skipped = 0;
  let splitCount = 0;
  let belowThreshold = 0;
  let verdictBasis = 0;
  const turnouts: number[] = [];
  const latencies: number[] = [];
  const perMember = new Map<string, { voted: number; eligible: number }>();

  for (const a of actions) {
    if (!isCcEligible(a.type)) continue;
    const epoch = committeeEpochForAction(a.decidedEpoch, currentEpoch);
    const active = epoch != null ? activeCommitteeMembersAt(members, epoch) : new Set<string>();
    if (epoch == null || active.size === 0) {
      skipped += 1;
      continue;
    }
    considered += 1;
    const finalByCold = finalCcVoteByMember(votesByAction.get(a.gaId) ?? [], members, hotToCold, epoch);
    turnouts.push((finalByCold.size / active.size) * 100);

    let hasYes = false;
    let hasNo = false;
    for (const v of finalByCold.values()) {
      if (v.vote === 'Yes') hasYes = true;
      else if (v.vote === 'No') hasNo = true;
      // submitted_at is unix milliseconds (the sync writes block_time * 1000),
      // vote block times are unix seconds, so normalize before comparing.
      if (a.submittedAt != null && v.blockTime != null && v.blockTime * 1000 >= a.submittedAt) {
        latencies.push((v.blockTime * 1000 - a.submittedAt) / 86_400_000);
      }
    }
    if (hasYes && hasNo) splitCount += 1;

    const snap = readThresholdSnapshot(a.thresholdsJson);
    if (snap?.cc != null && a.ccYesPct != null) {
      verdictBasis += 1;
      const met = snap.ccBelowMinSize ? false : a.ccYesPct >= snap.cc;
      if (!met) belowThreshold += 1;
    }

    for (const cold of active) {
      const entry = perMember.get(cold) ?? { voted: 0, eligible: 0 };
      entry.eligible += 1;
      if (finalByCold.has(cold)) entry.voted += 1;
      perMember.set(cold, entry);
    }
  }

  const memberRows: CcMemberRow[] = [...perMember.entries()]
    .map(([coldKeyHex, m]) => ({
      coldKeyHex,
      name: nameIndex.byCold(coldKeyHex),
      voted: m.voted,
      eligible: m.eligible,
      pct: m.eligible > 0 ? (m.voted / m.eligible) * 100 : 0,
    }))
    .sort((x, y) => y.pct - x.pct || (x.name ?? x.coldKeyHex).localeCompare(y.name ?? y.coldKeyHex));

  return {
    considered,
    skipped,
    medianTurnoutPct: median(turnouts),
    splitCount,
    belowThreshold,
    verdictBasis,
    medianLatencyDays: median(latencies),
    members: memberRows,
  };
}
