// Pure view models for a Constitutional Committee member's record page and the
// committee index. Every participation number is read off consideredCcActions,
// the same per-action reading the analytics panel uses, so a member's voted and
// eligible counts on its own page always equal the panel's. These rows are not
// DReps and never go through the DRep identity helpers.
import { committeeStanding, versionCovers, type CommitteeMemberTerm } from '../koios/committeeTimeline.js';
import { finalCcVoteByMember } from '../koios/corrections.js';
import { computeTenure } from '../analytics/ccPanelView.js';
import type { ConsideredCcAction } from '../analytics/ccParticipation.js';
import type { CcVoteRow, OpenCcVoteRow } from '../db/committee.js';
import { ccRationaleKey, type CcRationaleStates } from '../db/actionRationale.js';
import type { CcNameIndex } from './ccNames.js';
import { isReadableRationale, latestBallot } from './ccPositions.js';
import { isCcEligible } from './view.js';

export type CcStanding = 'Active' | 'Resigned' | 'Expired' | 'Former';

/**
 * A cold key's standing at the next transition, judged like the positions tab
 * (at `currentEpoch + 1`). Former when no term of this key is in force then.
 * Without a current epoch only a seat without any open term can be told
 * (Former), every other seat gets null.
 */
export function currentCcStanding(members: CommitteeMemberTerm[], coldKeyHex: string, currentEpoch: number | null): CcStanding | null {
  const terms = members.filter((m) => m.coldKeyHex === coldKeyHex);
  if (currentEpoch == null) return terms.some((t) => t.versionTo == null) ? null : 'Former';
  const term = terms.find((t) => versionCovers(t, currentEpoch + 1));
  if (term == null) return 'Former';
  const s = committeeStanding(term, currentEpoch + 1);
  return s === 'resigned' ? 'Resigned' : s === 'expired' ? 'Expired' : 'Active';
}

export interface CcRecordRow {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  type: string;
  status: string;
  decidedEpoch: number;
  /** Null means "Not voted". */
  vote: CcVoteRow | null;
}

export interface CcOpenVoteRow {
  gaId: string;
  title: string | null;
  topicSlug: string | null;
  vote: CcVoteRow;
}

export interface CcMemberProfileView {
  coldKeyHex: string;
  name: string | null;
  nameSource: ReturnType<CcNameIndex['sourceByCold']>;
  standing: CcStanding | null;
  tenure: { from: number; to: number | null };
  hotKeys: string[];
  voted: number;
  eligible: number;
  /** Null when the seat was never counted on a considered action. */
  pct: number | null;
  counts: { yes: number; no: number; abstain: number };
  /** One entry per considered action, ascending like the panel's sequence. */
  sequence: ('voted' | 'missed' | 'ineligible')[];
  /** Counted actions, newest first. */
  record: CcRecordRow[];
  /** Ballots on actions where this credential was not counted, newest first. */
  uncounted: CcRecordRow[];
  open: CcOpenVoteRow[];
}

interface Tally {
  voted: number;
  eligible: number;
  counts: { yes: number; no: number; abstain: number };
  sequence: ('voted' | 'missed' | 'ineligible')[];
  record: CcRecordRow[];
  uncounted: CcRecordRow[];
}

function recordRow(c: ConsideredCcAction, vote: CcVoteRow | null): CcRecordRow {
  const { gaId, title, topicSlug, type, status, decidedEpoch } = c.action;
  return { gaId, title, topicSlug, type, status, decidedEpoch, vote };
}

// One cold key across every considered action. Membership comes only from each
// action's own active set and final votes, never recomputed here.
function tallyMember(coldKeyHex: string, considered: ConsideredCcAction[], hotToCold: Map<string, string>): Tally {
  const t: Tally = { voted: 0, eligible: 0, counts: { yes: 0, no: 0, abstain: 0 }, sequence: [], record: [], uncounted: [] };
  for (const c of considered) {
    if (c.active.has(coldKeyHex)) {
      t.eligible += 1;
      const vote = c.finalByCold.get(coldKeyHex) ?? null;
      if (vote) {
        t.voted += 1;
        if (vote.vote === 'Yes') t.counts.yes += 1;
        else if (vote.vote === 'No') t.counts.no += 1;
        else t.counts.abstain += 1;
      }
      t.sequence.push(vote ? 'voted' : 'missed');
      t.record.push(recordRow(c, vote));
      continue;
    }
    t.sequence.push('ineligible');
    // The latest ballot of this credential, the same pick buildUncountedCcPositions makes.
    const latest = latestBallot(c.votes.filter((v) => hotToCold.get(v.hotKeyHex) === coldKeyHex));
    if (latest) t.uncounted.push(recordRow(c, latest));
  }
  t.record.reverse();
  t.uncounted.reverse();
  return t;
}

export function buildCcMemberProfile(input: {
  coldKeyHex: string;
  considered: ConsideredCcAction[];
  members: CommitteeMemberTerm[];
  hotToCold: Map<string, string>;
  nameIndex: CcNameIndex;
  currentEpoch: number | null;
  openVotes: OpenCcVoteRow[];
}): CcMemberProfileView | null {
  const { coldKeyHex, considered, members, hotToCold, nameIndex, currentEpoch, openVotes } = input;
  const terms = members.filter((m) => m.coldKeyHex === coldKeyHex);
  if (terms.length === 0) return null;

  const standing = currentCcStanding(members, coldKeyHex, currentEpoch);
  const tally = tallyMember(coldKeyHex, considered, hotToCold);

  const hotKeys: string[] = [];
  for (const [hot, cold] of hotToCold) if (cold === coldKeyHex) hotKeys.push(hot);

  // A resigned or expired credential is not in the active set at the next
  // transition, so its open ballots would not count and are left out.
  const open: CcOpenVoteRow[] = [];
  if (standing === 'Active' && currentEpoch != null) {
    const byAction = new Map<string, OpenCcVoteRow[]>();
    for (const v of openVotes) {
      if (!isCcEligible(v.type)) continue;
      const rows = byAction.get(v.gaId) ?? [];
      rows.push(v);
      byAction.set(v.gaId, rows);
    }
    for (const rows of byAction.values()) {
      const final = finalCcVoteByMember(rows, members, hotToCold, currentEpoch + 1).get(coldKeyHex);
      if (final == null) continue;
      const { gaId, title, topicSlug, voterId, hotKeyHex, vote, blockTime, metaUrl } = final;
      open.push({ gaId, title, topicSlug, vote: { voterId, hotKeyHex, vote, blockTime, metaUrl } });
    }
  }

  return {
    coldKeyHex,
    name: nameIndex.byCold(coldKeyHex),
    nameSource: nameIndex.sourceByCold(coldKeyHex),
    standing,
    tenure: computeTenure(terms, currentEpoch),
    hotKeys,
    voted: tally.voted,
    eligible: tally.eligible,
    pct: tally.eligible > 0 ? (tally.voted / tally.eligible) * 100 : null,
    counts: tally.counts,
    sequence: tally.sequence,
    record: tally.record,
    uncounted: tally.uncounted,
    open,
  };
}

/**
 * How many counted final votes in a record carry a readable rationale.
 * `states` is keyed by ccRationaleKey(gaId, voterId).
 */
export function countReadableRationales(record: CcRecordRow[], states: CcRationaleStates): number {
  let n = 0;
  for (const row of record) {
    if (row.vote == null) continue;
    const s = states.get(ccRationaleKey(row.gaId, row.vote.voterId));
    if (s && isReadableRationale(s.status, s.hasBody)) n += 1;
  }
  return n;
}

export interface CcIndexRow {
  coldKeyHex: string;
  name: string | null;
  standing: CcStanding | null;
  tenure: { from: number; to: number | null };
  voted: number;
  eligible: number;
}

/** Voted and eligible per cold key in one pass, the same reading tallyMember takes per key. */
export function participationByCold(considered: ConsideredCcAction[]): Map<string, { voted: number; eligible: number }> {
  const out = new Map<string, { voted: number; eligible: number }>();
  for (const c of considered) {
    for (const cold of c.active) {
      const p = out.get(cold) ?? { voted: 0, eligible: 0 };
      p.eligible += 1;
      if (c.finalByCold.has(cold)) p.voted += 1;
      out.set(cold, p);
    }
  }
  return out;
}

/** One row per cold key in the timeline, current seats first, then Former, each by name. */
export function buildCcIndex(input: {
  considered: ConsideredCcAction[];
  members: CommitteeMemberTerm[];
  hotToCold: Map<string, string>;
  nameIndex: CcNameIndex;
  currentEpoch: number | null;
}): CcIndexRow[] {
  const { considered, members, nameIndex, currentEpoch } = input;
  const termsByCold = new Map<string, CommitteeMemberTerm[]>();
  for (const m of members) {
    const arr = termsByCold.get(m.coldKeyHex) ?? [];
    arr.push(m);
    termsByCold.set(m.coldKeyHex, arr);
  }
  const participation = participationByCold(considered);
  const rows: CcIndexRow[] = [];
  for (const [coldKeyHex, terms] of termsByCold) {
    const { voted, eligible } = participation.get(coldKeyHex) ?? { voted: 0, eligible: 0 };
    rows.push({
      coldKeyHex,
      name: nameIndex.byCold(coldKeyHex),
      standing: currentCcStanding(members, coldKeyHex, currentEpoch),
      tenure: computeTenure(terms, currentEpoch),
      voted,
      eligible,
    });
  }
  const former = (r: CcIndexRow) => (r.standing === 'Former' ? 1 : 0);
  const label = (r: CcIndexRow) => (r.name ?? r.coldKeyHex).toLowerCase();
  rows.sort((a, b) => former(a) - former(b) || label(a).localeCompare(label(b)) || a.coldKeyHex.localeCompare(b.coldKeyHex));
  return rows;
}
