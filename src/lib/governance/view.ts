// Pure presentation helpers for governance actions: readable type, ada
// formatting, status badges, epoch countdown, tally bars, and vote tones. No I/O;
// all deterministic and unit-tested. Shared by the gov-sync first-post composer
// and the thread header / list rows. Explorer links live in config/network.ts
// (governanceActionUrl), since they are network-aware.

import { formatAda, formatAdaCompact } from '../format/ada.js';
import { epochStartUnix, type NetworkConfig } from '../config/network.js';
import { buildBodyStake } from './fullStakeView.js';
import type { Body } from './thresholds.js';

// Re-exported so governance components keep importing the ada formatters from
// this view module; the implementations live in lib/format/ada.ts.
export { formatAda, formatAdaCompact };

// Milliseconds per day, for the wall-clock voting countdown.
const DAY_MS = 24 * 60 * 60 * 1000;

/** "TreasuryWithdrawals" -> "Treasury Withdrawals". */
export function readableType(type: string): string {
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export type StatusTone = 'active' | 'positive' | 'negative' | 'neutral';
export interface StatusBadge {
  label: string;
  tone: StatusTone;
}

/** Maps a lifecycle status to a label + color tone for the badge. */
export function statusBadge(status: string): StatusBadge {
  switch (status) {
    case 'pending':
      // Discovered on-chain but its status/tallies are not synced yet; shown as
      // "Syncing" (our own sync state, not an on-chain status), neutral.
      return { label: 'Syncing', tone: 'neutral' };
    case 'active':
      return { label: 'Active', tone: 'active' };
    case 'ratified':
      return { label: 'Ratified', tone: 'positive' };
    case 'enacted':
      return { label: 'Enacted', tone: 'positive' };
    case 'dropped':
      return { label: 'Dropped', tone: 'negative' };
    case 'expired':
      return { label: 'Expired', tone: 'neutral' };
    case 'closed':
      // An info action's voting window ended; info actions can never enact.
      return { label: 'Closed', tone: 'neutral' };
    default:
      return { label: status.charAt(0).toUpperCase() + status.slice(1), tone: 'neutral' };
  }
}

/**
 * Past-tense verb phrase for a governance status change, used by the activity
 * feed ("<Title> was enacted"). Mirrors the statusBadge vocabulary. Only terminal
 * outcomes reach the feed (pending -> active is suppressed in tallySync), so there
 * is deliberately no 'active' phrasing here.
 */
export function govStatusVerb(to: string): string {
  switch (to) {
    case 'ratified':
      return 'was ratified';
    case 'enacted':
      return 'was enacted';
    case 'dropped':
      return 'was dropped';
    case 'expired':
      return 'expired';
    case 'closed':
      return 'was closed';
    default:
      return `is now ${to}`;
  }
}

// Lifecycle statuses whose voting window is over and whose outcome is frozen. The
// rest ('active', and the not-yet-synced 'pending') are still open and counting down.
// Exported as the single source of truth: isTerminalStatus tests membership here, and
// the Closing-Soon list query spreads it into a parameterized NOT IN filter, so the
// in-memory and SQL definitions of "terminal" can never drift.
export const TERMINAL_STATUSES = ['ratified', 'enacted', 'dropped', 'expired', 'closed'] as const;

// The open lifecycle statuses: still counting down, no frozen outcome yet. Paired with
// TERMINAL_STATUSES as the single source of truth for the governance status filter, so
// the "open" and "decided" SQL sets cannot drift from the badge lifecycle.
export const OPEN_STATUSES = ['pending', 'active'] as const;

const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_STATUSES);

/** True when the action's voting window has ended (a frozen, terminal outcome). */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

/**
 * Human countdown to voting close ("~3 days left (epoch 294)"), built on
 * epochDaysLeft. Returns null whenever epochDaysLeft does. expiryEpoch is the
 * label only; expiryUnixMs (the start of that epoch) drives the day count.
 */
export function epochCountdown(
  expiryEpoch: number | null,
  expiryUnixMs: number | null,
  status: string,
  now: number,
): string | null {
  const days = epochDaysLeft(expiryUnixMs, status, now);
  if (days == null) return null;
  return `~${days} ${days === 1 ? 'day' : 'days'} left (epoch ${expiryEpoch})`;
}

/**
 * Whole calendar days until voting closes, rounded up, measured from `now` to the
 * start of the expiry epoch (expiryUnixMs): on-chain an action is ratified or
 * expired at the boundary into its expiration epoch, so that boundary is when
 * votes stop counting. Null when unknown, already past, or the status is terminal
 * (a concluded action is not "counting down" even if its boundary lies ahead).
 * The bare number powers the list row's "~N days left" headline.
 *
 * Wall-clock, not epoch arithmetic: the previous (expiryEpoch - tallyEpoch) * 5
 * rounded to whole 5-day epochs and assumed the current epoch had just begun, so
 * it over-counted by however far we already were into it (e.g. "5 days" with ~1
 * actually left). Callers pass epochStartMs(expiryEpoch), keeping this helper free
 * of network config and consistent with the separately shown "Voting ends" date.
 */
export function epochDaysLeft(
  expiryUnixMs: number | null,
  status: string,
  now: number,
): number | null {
  if (isTerminalStatus(status)) return null;
  if (expiryUnixMs == null) return null;
  const msLeft = expiryUnixMs - now;
  if (msLeft <= 0) return null;
  return Math.ceil(msLeft / DAY_MS);
}

export interface TallyBar {
  yes: number;
  no: number;
  abstain: number;
}

/**
 * Builds a yes/no/abstain bar from the power-weighted yes/no percentages.
 * Abstain is the remainder. Returns null when no tally has been synced yet.
 */
export function tallyBar(yesPct: number | null, noPct: number | null): TallyBar | null {
  if (yesPct == null && noPct == null) return null;
  const yes = clampPct(yesPct ?? 0);
  const no = clampPct(noPct ?? 0);
  const abstain = clampPct(100 - yes - no);
  return { yes, no, abstain };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Whether the author's current on-chain vote differs from the vote a frozen
 * rationale post was cast with. posts.vote is stored lowercase while
 * drep_votes.vote is Koios-cased ('Yes'/'No'/'Abstain'), so the comparison is
 * case-insensitive. Missing either side reads as unchanged: no current vote row
 * (or a post without a vote) is not evidence of a change.
 */
export function voteChangedSince(
  postVote: string | null | undefined,
  currentVote: string | null | undefined,
): boolean {
  if (!postVote || !currentVote) return false;
  return postVote.toLowerCase() !== currentVote.toLowerCase();
}

/**
 * Normalizes a stored vote to the three counting buckets: anything that is not
 * Yes/No folds into Abstain. Single source for vote bucketing so the tally
 * helpers, badges, and the record filter cannot drift.
 */
export function voteBucket(vote: string): 'yes' | 'no' | 'abstain' {
  const v = vote.toLowerCase();
  return v === 'yes' ? 'yes' : v === 'no' ? 'no' : 'abstain';
}

/** Color tone for a vote badge. */
export function voteTone(vote: string): StatusTone {
  const v = vote.toLowerCase();
  if (v === 'yes') return 'positive';
  if (v === 'no') return 'negative';
  return 'neutral';
}

// CSS color per tone, owned here next to the tone vocabulary so badges across
// the header, list rows, and vote pills never drift. All four are theme
// variables: the dark theme lifts --c-pos / --c-neg to pastels, so tone text
// stays legible there instead of keeping the light theme's deep hues.
export const TONE_COLORS: Record<StatusTone, string> = {
  active: 'var(--accent)',
  positive: 'var(--c-pos)',
  negative: 'var(--c-neg)',
  neutral: 'var(--muted)',
};

// Softer fills for the stacked tally bar. Here the tone paints a large surface
// rather than text or a white-on-color badge, so it can be gentler than the
// saturated tones above without hurting legibility.
export const TONE_BAR_COLORS = {
  positive: '#5cb88a',
  negative: '#e07d75',
  neutral: 'var(--muted)',
} as const;

// One formatter, reused everywhere, so epoch dates read identically in the list
// row and the thread header. UTC keeps it deterministic (no server-timezone
// drift); epoch boundaries are themselves defined in UTC.
const EPOCH_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** "Jul 29, 2020" from a unix-seconds timestamp (see network.ts epochStartUnix). */
export function formatEpochDate(unixSeconds: number): string {
  return EPOCH_DATE_FMT.format(new Date(unixSeconds * 1000));
}

// Exact on-chain submission times (governance_actions.submitted_at) get minutes
// and a spelled-out zone, unlike epoch boundaries: the whole point of storing
// block_time is showing when in the epoch the action actually landed.
const SUBMITTED_AT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  timeZoneName: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "Jul 31, 2026, 17:34 UTC" from a unix-ms timestamp (governance_actions.submitted_at). */
export function formatSubmittedDateTime(unixMs: number): string {
  return SUBMITTED_AT_FMT.format(new Date(unixMs));
}

/**
 * Submission date for display: the exact on-chain time when the sync has stored
 * it, else the submitted-epoch start (up to ~5 days early), else null. The one
 * place that encodes this preference, so every surface shows the same date.
 */
export function submittedDateLabel(
  submittedAt: number | null,
  submittedEpoch: number | null,
  cfg: NetworkConfig,
): string | null {
  if (submittedAt != null) return formatSubmittedDateTime(submittedAt);
  if (submittedEpoch != null) return formatEpochDate(epochStartUnix(submittedEpoch, cfg));
  return null;
}

// Color tone per governance action type, for the pastel category pill on list
// rows. Matched on a normalized (lowercase, despaced) form so it survives both
// the raw on-chain type ("TreasuryWithdrawals") and a readable one.
export type GovTypeTone =
  | 'constitution'
  | 'treasury'
  | 'parameter'
  | 'info'
  | 'hardfork'
  | 'committee'
  | 'noconfidence'
  | 'other';

export function govTypeTone(type: string): GovTypeTone {
  const t = type.toLowerCase().replace(/[^a-z]/g, '');
  if (t.includes('constitution')) return 'constitution';
  if (t.includes('treasury')) return 'treasury';
  if (t.includes('parameter')) return 'parameter';
  if (t.includes('info')) return 'info';
  if (t.includes('hardfork')) return 'hardfork';
  if (t.includes('committee')) return 'committee';
  if (t.includes('confidence')) return 'noconfidence';
  return 'other';
}

// Per-type Open Graph image for a governance action, served from public/og/.
// An unrecognized type ('other') has no dedicated card and falls back to the
// site default OG image.
export function govActionOgImage(type: string): string {
  const tone = govTypeTone(type);
  return tone === 'other' ? '/og.jpg' : `/og/gov-${tone}.png`;
}

// OG card for a forum thread: the per-type card for a governance action, the
// generic discussion card for a plain thread, and undefined (so Layout uses the
// site default) for a governance topic whose action row has not synced yet.
export function threadOgImage(
  govAction: { type: string } | null,
  isGovernanceTopic: boolean,
): string | undefined {
  if (govAction) return govActionOgImage(govAction.type);
  return isGovernanceTopic ? undefined : '/og/discussion.png';
}

/** Formats a tally percentage: two decimals for tiny non-zero values, else whole. */
export function fmtPct(n: number): string {
  return `${n.toFixed(n > 0 && n < 1 ? 2 : 0)}%`;
}

/**
 * Percentage with one decimal (two below 1%), for headline ratification shares where
 * the plain integer rounding of fmtPct (6.84 -> "7%") would hide how small the real
 * support is. Whole 100 stays "100%".
 */
export function fmtPctFine(n: number): string {
  if (n <= 0) return '0%';
  if (n < 1) return `${n.toFixed(2)}%`;
  if (n < 100) return `${n.toFixed(1)}%`;
  return `${n.toFixed(0)}%`;
}

// Which voter role leads a governance-action overview row. The detail header
// always shows DRep + SPO + CC side by side; the compact row has space for one
// tally, so we pick the role that actually decides the action.
export type VoterRole = 'DRep' | 'SPO';

/**
 * True for action types the overview leads with the SPO tally. Only hard-fork
 * initiation qualifies: SPOs are the operational gatekeeper (they must run the
 * new node version) and historically carried the decision while DReps were
 * absent, so the SPO tally is the meaningful one. No-confidence and committee
 * updates are also co-decided by SPOs under CIP-1694, but there the DRep tally is
 * the richer community signal (and the only one with turnout data), so they lead
 * with DRep and fall back to SPO via overviewTally only when DRep is empty. The
 * full DRep + SPO + CC breakdown always lives in the detail header.
 */
export function isSpoLedType(type: string): boolean {
  return govTypeTone(type) === 'hardfork';
}

// The per-role tally fields the overview picker reads. A subset of
// GovernanceAction, so the full action is assignable without a cast.
export interface RoleTallyInput {
  type: string;
  status: string;
  drepYesPct: number | null;
  drepNoPct: number | null;
  drepYes: number | null;
  drepNo: number | null;
  drepAbstain: number | null;
  spoYesPct: number | null;
  spoNoPct: number | null;
  spoYes: number | null;
  spoNo: number | null;
  spoAbstain: number | null;
}

export interface OverviewTally {
  role: VoterRole;   // whose tally the row's sentiment + voter count represent
  bar: TallyBar;
  voted: number;     // voters of that role who cast yes/no/abstain
  // True when the bar's "no" share is purely non-voting stake counted as No by the
  // ledger default (open hard fork, SPO-led, zero pools actually voted No), so it
  // should read as "not yet voted" rather than hostile opposition.
  noIsPending: boolean;
}

/**
 * Picks which role's tally leads an overview row. SPO-led types (see
 * isSpoLedType) prefer the SPO tally, all others prefer DRep; if the preferred
 * role has no synced tally we fall back to the other. The fallback is what keeps
 * a bootstrap-era hard fork (ratified by SPOs + CC while DReps cast nothing)
 * from showing an empty DRep bar. Returns null when neither role has a tally.
 */
export function overviewTally(a: RoleTallyInput): OverviewTally | null {
  const order: VoterRole[] = isSpoLedType(a.type) ? ['SPO', 'DRep'] : ['DRep', 'SPO'];
  for (const role of order) {
    const bar = role === 'SPO' ? tallyBar(a.spoYesPct, a.spoNoPct) : tallyBar(a.drepYesPct, a.drepNoPct);
    if (!bar) continue;
    const voted =
      role === 'SPO'
        ? (a.spoYes ?? 0) + (a.spoNo ?? 0) + (a.spoAbstain ?? 0)
        : (a.drepYes ?? 0) + (a.drepNo ?? 0) + (a.drepAbstain ?? 0);
    // On an open hard fork the SPO "no" share is the ledger default for pools that
    // have not voted; when no pool cast an explicit No (spoNo count is 0) that share
    // is entirely non-voting stake, so we relabel it "not yet voted" instead of
    // "against". Once a pool votes No, or the action freezes, we cannot tell the two
    // apart and keep the literal No share.
    const noIsPending =
      role === 'SPO' &&
      isSpoLedType(a.type) &&
      !isTerminalStatus(a.status) &&
      (a.spoNo ?? 0) === 0 &&
      bar.no > 0;
    return { role, bar, voted, noIsPending };
  }
  return null;
}

// Which of DRep/SPO/CC vote per CIP-1694 for each action type. Mirrors the
// threshold plan() in thresholds.ts, minus the ParameterChange payload nuance
// (touchesSecurity/groups): ParameterChange defaults to its always-present
// bodies (DRep, CC) here, and eligibleBodies() below adds the SPO seat when
// the caller passes paramTouchesSecurity, or dynamically whenever the action
// actually carries cast SPO votes (belt and suspenders if that flag is absent).
const ELIGIBLE_BY_TYPE: Record<string, Body[]> = {
  InfoAction: ['DRep', 'SPO', 'CC'],
  NoConfidence: ['DRep', 'SPO'],
  NewCommittee: ['DRep', 'SPO'],
  NewConstitution: ['DRep', 'CC'],
  HardForkInitiation: ['DRep', 'SPO', 'CC'],
  TreasuryWithdrawals: ['DRep', 'CC'],
  ParameterChange: ['DRep', 'CC'],
};

// Fallback eligibility for an unrecognized type: the full CIP-1694 body set, so
// an unknown action still renders a sensible row rather than an empty one.
const DEFAULT_ELIGIBLE: Body[] = ['DRep', 'SPO', 'CC'];

/** Whether the Constitutional Committee is entitled to vote on this action type. */
export function isCcEligible(type: string): boolean {
  return (ELIGIBLE_BY_TYPE[type] ?? DEFAULT_ELIGIBLE).includes('CC');
}

// Fixed render order for the overview row, independent of ELIGIBLE_BY_TYPE's
// per-type array order above.
const BODY_ORDER: Body[] = ['DRep', 'SPO', 'CC'];

const BODY_LABEL: Record<Body, string> = { DRep: 'DReps', SPO: 'SPOs', CC: 'CC' };

// The vote-cast fields overviewRowVoting reads per body, keyed by whether the
// body has cast anything at all (used both to union a dynamically-present body
// into eligibility, and to build the advisory cast-vote bar).
function bodyHasCastVotes(a: RowVotingInput, body: Body): boolean {
  switch (body) {
    case 'DRep':
      return (a.drepYesPower ?? 0) > 0 || (a.drepNoPower ?? 0) > 0 || (a.drepAbstainPower ?? 0) > 0;
    case 'SPO':
      return (a.spoYesPower ?? 0) > 0 || (a.spoNoPower ?? 0) > 0 || (a.spoAbstainPower ?? 0) > 0;
    case 'CC':
      return (a.ccYes ?? 0) > 0 || (a.ccNo ?? 0) > 0 || (a.ccAbstain ?? 0) > 0;
  }
}

/**
 * The bodies that vote on this action type (CIP-1694), unioned with:
 * - any body that actually cast votes (covers a ParameterChange SPO seat we
 *   cannot statically resolve from ELIGIBLE_BY_TYPE alone), and
 * - the SPO seat when the caller tells us this ParameterChange touches a
 *   security-relevant parameter (constitution PARAM-03a; see
 *   parameterChangeScope in onchain.ts), so SPOs show as an eligible body
 *   from the start of voting, before any pool has cast a vote.
 * Returned in fixed DRep, SPO, CC order.
 */
function eligibleBodies(a: RowVotingInput, paramTouchesSecurity: boolean): Body[] {
  const statically = new Set(ELIGIBLE_BY_TYPE[a.type] ?? DEFAULT_ELIGIBLE);
  if (a.type === 'ParameterChange' && paramTouchesSecurity) statically.add('SPO');
  for (const body of BODY_ORDER) {
    if (bodyHasCastVotes(a, body)) statically.add(body);
  }
  return BODY_ORDER.filter((body) => statically.has(body));
}

/**
 * A short note naming the bodies that cannot vote on this action type, e.g. "SPOs do
 * not vote on treasury withdrawals". Null when every body can vote (info actions) or,
 * for a security-relevant ParameterChange, when SPOs are eligible. Shown on the detail
 * page's Voting Information card, not on the overview row (where the missing body row
 * already implies it and the note would be repetitive).
 */
export function absentBodyNote(
  a: RowVotingInput,
  opts?: { paramTouchesSecurity?: boolean },
): string | null {
  const eligible = new Set(eligibleBodies(a, opts?.paramTouchesSecurity ?? false));
  const absent = BODY_ORDER.filter((body) => !eligible.has(body));
  if (absent.length === 0) return null;
  return `${absent.map((body) => BODY_LABEL[body]).join(' and ')} do not vote on ${readableType(a.type).toLowerCase()}`;
}


/**
 * Turnout (0..100) for one body: the stake that actually cast a vote over ALL of
 * that body's eligible stake. One basis for every body, so the DRep and SPO numbers
 * in the same card answer the same question and can be read against each other.
 *
 * This used to differ per body. DRep turnout divided by the active DRep stake, which
 * already has the always-abstain delegations removed, while SPO turnout divided by
 * every pool's stake including them. The same action then reported 71% DRep turnout
 * next to 28% SPO turnout, a gap that was mostly denominator, not behaviour.
 *
 * Null until the action's stake buckets are captured (see buildBodyStake), so an
 * un-backfilled action shows no turnout rather than one on the old basis. CC turnout
 * stays a seat count, which has no stake denominator to get wrong.
 */
function participationFor(
  a: RowVotingInput,
  body: Body,
  opts: { drepStakeTotal: number | null; committeeSize: number | null },
): number | null {
  if (body === 'CC') {
    if (!opts.committeeSize) return null;
    const cast = (a.ccYes ?? 0) + (a.ccNo ?? 0) + (a.ccAbstain ?? 0);
    return clampPct((cast / opts.committeeSize) * 100);
  }
  return bodyStake(a, body)?.turnoutPct ?? null;
}

// The fields overviewRowVoting reads off a governance action: type (for
// eligibility + ratification-vs-advisory), the per-body tallies, cast vote
// power/counts, and the participation numerators. A subset of GovernanceAction,
// so the full action is assignable without a cast.
export interface RowVotingInput {
  type: string;
  drepYesPct: number | null;
  drepNoPct: number | null;
  spoYesPct: number | null;
  spoNoPct: number | null;
  ccYesPct: number | null;
  ccNoPct: number | null;
  drepYes: number | null;
  drepNo: number | null;
  drepAbstain: number | null;
  spoYes: number | null;
  spoNo: number | null;
  spoAbstain: number | null;
  ccYes: number | null;
  ccNo: number | null;
  ccAbstain: number | null;
  drepYesPower: number | null;
  drepNoPower: number | null;
  drepAbstainPower: number | null;
  spoYesPower: number | null;
  spoNoPower: number | null;
  spoAbstainPower: number | null;
  drepVotedPower: number | null;
  spoEligiblePower: number | null;
  // The captured stake buckets (raw lovelace strings), read only through bodyStake.
  drepNoSidePower: string | null;
  spoNoSidePower: string | null;
  drepAlwaysAbstainPower: string | null;
  drepAlwaysNoConfidencePower: string | null;
  spoAlwaysAbstainPower: string | null;
  spoAlwaysNoConfidencePower: string | null;
}

export interface RowBodyVoting {
  body: Body;                   // 'DRep' | 'SPO' | 'CC'
  label: string;                // 'DReps' | 'SPOs' | 'CC'
  participation: number | null; // 0..100 turnout, null when unavailable
  // Honest Yes/No/Not-voted composition over eligible power (the overview's single
  // merged bar). Null when this body has no synced tally yet.
  composition: CompositionBar | null;
}

export interface OverviewRowVoting {
  bodies: RowBodyVoting[]; // only eligible bodies, fixed order DRep, SPO, CC
  absentBodies: Body[];    // bodies that cannot vote on this type (for the note)
}

/**
 * The single leading body's honest Yes-of-eligible share for the compact OG card. SPO-led
 * types (see isSpoLedType) lead with SPO, all others with DRep; `order` covers both, so the
 * first with a synced composition wins. Its .yes is the stored ratification pct (denominator
 * independent), so the share image leads with the same honest number the detail page shows.
 * Returns null when no eligible body has a synced tally yet.
 */
export function headlineComposition(a: RowVotingInput): { yesPct: number; role: VoterRole } | null {
  const pick = leadingComposition(a, { drepStakeTotal: null, committeeSize: null });
  return pick ? { yesPct: pick.bar.yes, role: pick.role } : null;
}

/**
 * The leading body's full Yes/No/Not-voted composition bar for an action: SPO-led
 * types (see isSpoLedType) lead with SPO, all others with DRep; the first body with
 * a synced composition wins. opts feeds the honest No-vs-Not-voted split
 * (drepStakeTotal / committeeSize); pass null for a share-only context. Returns null
 * when no eligible body has a synced tally yet. The single source of the leading-body
 * pick, shared by headlineComposition (which projects .yes for the OG card) and the
 * homepage hero tally bar (which renders the whole bar against the real denominator).
 */
export function leadingComposition(
  a: RowVotingInput,
  opts: { drepStakeTotal: number | null; committeeSize: number | null },
): { bar: CompositionBar; role: VoterRole } | null {
  const { bodies } = overviewRowVoting(a, opts);
  const order: VoterRole[] = isSpoLedType(a.type) ? ['SPO', 'DRep'] : ['DRep', 'SPO'];
  for (const role of order) {
    const body = bodies.find((x) => x.body === role && x.composition != null);
    if (body?.composition) return { bar: body.composition, role };
  }
  return null;
}

/**
 * Per-body voting model for the overview row: one entry per eligible body
 * (DRep/SPO/CC), each with a participation (turnout) percentage and the honest
 * Yes/No/Not-voted composition over eligible power. absentBodies lists the
 * CIP-1694-expected bodies this type does not use (e.g. SPO for a treasury
 * withdrawal), for the row's "does not vote here" note.
 *
 * paramScope.paramTouchesSecurity marks a ParameterChange whose decoded payload
 * touches a security-relevant parameter (constitution PARAM-03a): SPOs are
 * eligible on such a change from the start of voting, not only once a pool has
 * actually cast a vote (see eligibleBodies). It defaults to false, so callers
 * that do not pass it keep the prior DRep+CC-only behavior for ParameterChange
 * until a body casts a vote.
 */
export function overviewRowVoting(
  a: RowVotingInput,
  opts: { drepStakeTotal: number | null; committeeSize: number | null },
  paramScope: { paramTouchesSecurity: boolean } = { paramTouchesSecurity: false },
): OverviewRowVoting {
  const eligible = eligibleBodies(a, paramScope.paramTouchesSecurity);
  const bodies: RowBodyVoting[] = eligible.map((body) => ({
    body,
    label: BODY_LABEL[body],
    participation: participationFor(a, body, opts),
    composition: bodyComposition(a, body),
  }));
  // absentBodies are the normally-expected CIP-1694 bodies (the full DRep/SPO/CC
  // set) that are not eligible here, e.g. SPO for a treasury withdrawal. Compared
  // against BODY_ORDER, not ELIGIBLE_BY_TYPE[a.type]: the latter IS the eligible
  // set, so diffing against itself would always be empty.
  const eligibleSet = new Set(eligible);
  const absentBodies = BODY_ORDER.filter((body) => !eligibleSet.has(body));
  return { bodies, absentBodies };
}

/**
 * The ratification split for one body: Yes and the No side, over the denominator the
 * threshold is actually measured against (yes + no side). The two always sum to 100.
 *
 * The No side is not "everyone who voted No". It is what the ledger counts against the
 * action: the cast No votes, the always-no-confidence stake, AND every eligible holder
 * who never voted at all. Abstain is the only thing that leaves the denominator.
 *
 * An earlier version drew a third, neutral Not-voted segment so a low-turnout action
 * would not read as a wall of opposition. Well meant, but it described a tally rule
 * that does not exist: non-voting stake is not neutral, it defeats the action exactly
 * like a No. The nuance it was reaching for is real and now lives where it is true, in
 * the per-segment breakdown (buildBodyStake), which names how much of the No side never
 * voted. The bar itself states the rule.
 */
export interface CompositionBar {
  yes: number; // 0..100, the stored ratification pct (matches gov.tools)
  no: number;  // 0..100, the remainder; yes + no === 100
}

/** The ratification split from the stored percentage. Null before a tally syncs. */
export function compositionBar(input: { yesPct: number | null }): CompositionBar | null {
  if (input.yesPct == null) return null;
  const yes = clampPct(input.yesPct);
  return { yes, no: 100 - yes };
}

/** The stored ratification pct for one body. */
export function bodyComposition(a: RowVotingInput, body: Body): CompositionBar | null {
  const yesPct = body === 'DRep' ? a.drepYesPct : body === 'SPO' ? a.spoYesPct : a.ccYesPct;
  return compositionBar({ yesPct });
}

/**
 * The captured stake model for one body, or null for CC (seat counts, no stake) and
 * for any action whose buckets predate the capture. The one place the view layer
 * reads them, so turnout, the excluded total and the breakdown cannot drift apart.
 */
export function bodyStake(a: RowVotingInput, body: Body, thresholdPct: number | null = null) {
  if (body === 'CC') return null;
  const drep = body === 'DRep';
  return buildBodyStake({
    actionType: a.type,
    activeYesPower: drep ? a.drepYesPower : a.spoYesPower,
    activeNoPower: drep ? a.drepNoPower : a.spoNoPower,
    activeAbstainPower: drep ? a.drepAbstainPower : a.spoAbstainPower,
    noSidePower: drep ? a.drepNoSidePower : a.spoNoSidePower,
    alwaysAbstainPower: drep ? a.drepAlwaysAbstainPower : a.spoAlwaysAbstainPower,
    alwaysNoConfidencePower: drep ? a.drepAlwaysNoConfidencePower : a.spoAlwaysNoConfidencePower,
    approvalThresholdPct: thresholdPct,
  });
}

// Pre-formatted amounts behind a composition bar: Yes / No / Not voted, plus the
// abstained stake shown as an excluded footnote. Compact ada for DRep/SPO, member
// counts for CC. notVoted/abstainExcluded are "n/a" when their denominator is unknown.
export interface CompositionAmounts {
  yes: string;
  no: string;
  notVoted: string;
  abstainExcluded: string;
  hasAbstain: boolean; // whether to render the abstain-excluded footnote at all
}

export function compositionAmounts(
  a: RowVotingInput,
  body: Body,
  opts: { drepStakeTotal: number | null; committeeSize: number | null },
): CompositionAmounts | null {
  if (body === 'CC') {
    const yes = a.ccYes ?? 0;
    const no = a.ccNo ?? 0;
    const abstain = a.ccAbstain ?? 0;
    if (a.ccYes == null && a.ccNo == null && a.ccAbstain == null) return null;
    const size = opts.committeeSize;
    const notVoted = size != null ? Math.max(0, size - yes - no - abstain) : null;
    return {
      yes: String(yes),
      no: String(no),
      notVoted: notVoted != null ? String(notVoted) : 'n/a',
      abstainExcluded: String(abstain),
      hasAbstain: abstain > 0,
    };
  }
  const yesP = body === 'DRep' ? a.drepYesPower : a.spoYesPower;
  const noP = body === 'DRep' ? a.drepNoPower : a.spoNoPower;
  const abP = body === 'DRep' ? a.drepAbstainPower : a.spoAbstainPower;
  if (yesP == null && noP == null && abP == null) return null;
  const eligible = body === 'DRep' ? opts.drepStakeTotal : a.spoEligiblePower;
  // Voted = yes + no + abstain; Not voted is the rest of the eligible power. For DRep
  // we have the stored drepVotedPower; for SPO sum the cast options.
  const voted =
    body === 'DRep' ? a.drepVotedPower : (a.spoYesPower ?? 0) + (a.spoNoPower ?? 0) + (a.spoAbstainPower ?? 0);
  const notVoted = eligible != null && voted != null ? Math.max(0, eligible - voted) : null;
  return {
    yes: formatAdaCompact(yesP ?? 0) ?? '0 ₳',
    no: formatAdaCompact(noP ?? 0) ?? '0 ₳',
    notVoted: notVoted != null ? (formatAdaCompact(notVoted) ?? '0 ₳') : 'n/a',
    abstainExcluded: formatAdaCompact(abP ?? 0) ?? '0 ₳',
    hasAbstain: (abP ?? 0) > 0,
  };
}

/**
 * Display fallback for governance actions without a resolved title: shortens
 * the raw "<64-hex txHash>#<index>" id to "abcdef…12345#0". Anything that does
 * not match the id shape is returned unchanged.
 */
export function shortGovActionId(id: string): string {
  const m = /^([0-9a-fA-F]{64})#(\d+)$/.exec(id);
  if (!m) return id;
  return `${m[1].slice(0, 6)}…${m[1].slice(-5)}#${m[2]}`;
}
