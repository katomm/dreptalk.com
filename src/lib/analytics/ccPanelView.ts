// Pure view model for the hub's Constitutional Committee panel. Every
// per-action reading replays the exact logic the GA pages use, the same
// eligibility epoch, the same active-member set and the same final-vote
// dedup, so the hub can never disagree with an action's own Votes tab.
// Actions that cannot be resolved are skipped and disclosed, and the
// below-threshold rate only uses the frozen per-action snapshot. The Cardano
// Japan Council appears twice on purpose: its interim-committee credential
// (epochs 507 to 580) and its elected-committee credential (since 581) are
// two cold keys with their own eligibility windows, so merging them by name
// would misstate eligibility.
import { activeCommitteeMembersAt, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import { finalCcVoteByMember } from '../koios/corrections.js';
import { committeeEpochForAction, type CcVoteRow, type DecidedCcAction } from '../db/committee.js';
import type { CcNameIndex } from '../governance/ccNames.js';
import { readThresholdSnapshot } from '../governance/thresholds.js';
import { isCcEligible } from '../governance/view.js';

export interface CcMemberRow {
  coldKeyHex: string;
  name: string | null;
  voted: number;
  eligible: number;
  pct: number;
  /** From the earliest term this member started (never below its own authorization epoch), to null while a term is still current. */
  tenure: { from: number; to: number | null };
  /** One entry per CcPanelView.actionEpochs, whether this member voted, missed, or was not on the active set for that action. */
  sequence: ('voted' | 'missed' | 'ineligible')[];
}

export interface CcPanelView {
  considered: number;
  skipped: number;
  medianTurnoutPct: number | null;
  splitCount: number;
  belowThreshold: number;
  verdictBasis: number;
  medianLatencyDays: number | null;
  /** Decided epochs of the considered actions, ascending, ties broken by gaId. One entry per member sequence position. */
  actionEpochs: number[];
  members: CcMemberRow[];
}

/** Selects the best and worst n rows from an already best-first sorted list. Under 2n rows, everything is "top" and there is no bottom. */
export function selectExtremes<T>(rows: T[], n: number): { top: T[]; bottom: T[]; total: number } {
  const total = rows.length;
  if (total <= 2 * n) return { top: [...rows], bottom: [], total };
  return { top: rows.slice(0, n), bottom: rows.slice(total - n), total };
}

/**
 * Tenure across every term a cold key has held. `from` is the earliest term's
 * start, never below that term's own hot-key authorization epoch. `to` is
 * null while any term is still current (open version, not resigned, term not
 * yet expired), otherwise the latest of each term's end (its expiration, or
 * the epoch before resignation when it resigned).
 */
function computeTenure(terms: CommitteeMemberTerm[], currentEpoch: number | null): { from: number; to: number | null } {
  if (terms.length === 0) return { from: 0, to: null };
  let earliest = terms[0];
  for (const t of terms) {
    if (t.versionFrom < earliest.versionFrom) earliest = t;
  }
  const from = Math.max(earliest.versionFrom, earliest.authorizedFrom);
  const isCurrent = terms.some(
    (t) => t.versionTo == null && t.resignedAt == null && currentEpoch != null && t.termExpiration >= currentEpoch,
  );
  if (isCurrent) return { from, to: null };
  let to = -Infinity;
  for (const t of terms) {
    const end = t.resignedAt != null ? Math.min(t.termExpiration, t.resignedAt - 1) : t.termExpiration;
    if (end > to) to = end;
  }
  return { from, to };
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
  const actionEpochs: number[] = [];
  const perMember = new Map<string, { voted: number; eligible: number; seq: Map<number, 'voted' | 'missed'> }>();

  const termsByCold = new Map<string, CommitteeMemberTerm[]>();
  for (const m of members) {
    const arr = termsByCold.get(m.coldKeyHex) ?? [];
    arr.push(m);
    termsByCold.set(m.coldKeyHex, arr);
  }

  // Sorted so every member's sequence lines up position-by-position with
  // actionEpochs, regardless of the order actions arrived in.
  const eligibleActions = actions
    .filter((a) => isCcEligible(a.type))
    .sort((x, y) => x.decidedEpoch - y.decidedEpoch || x.gaId.localeCompare(y.gaId));

  for (const a of eligibleActions) {
    const epoch = committeeEpochForAction(a.decidedEpoch, currentEpoch);
    if (epoch == null) {
      skipped += 1;
      continue;
    }
    const active = activeCommitteeMembersAt(members, epoch);
    if (active.size === 0) {
      skipped += 1;
      continue;
    }
    considered += 1;
    const index = actionEpochs.length;
    actionEpochs.push(a.decidedEpoch);
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
      const met = !snap.ccBelowMinSize && a.ccYesPct >= snap.cc;
      if (!met) belowThreshold += 1;
    }

    for (const cold of active) {
      const entry = perMember.get(cold) ?? { voted: 0, eligible: 0, seq: new Map<number, 'voted' | 'missed'>() };
      entry.eligible += 1;
      const voted = finalByCold.has(cold);
      if (voted) entry.voted += 1;
      entry.seq.set(index, voted ? 'voted' : 'missed');
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
      tenure: computeTenure(termsByCold.get(coldKeyHex) ?? [], currentEpoch),
      sequence: actionEpochs.map((_, i) => m.seq.get(i) ?? 'ineligible') as CcMemberRow['sequence'],
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
    actionEpochs,
    members: memberRows,
  };
}
