// Pure presentation helpers for governance actions: readable type, ADA
// formatting, status badges, epoch countdown, tally bars, and vote tones. No I/O;
// all deterministic and unit-tested. Shared by the gov-sync first-post composer
// and the thread header / list rows. Explorer links live in config/network.ts
// (governanceActionUrl), since they are network-aware.

import { formatAda, formatAdaCompact } from '../format/ada.js';
import type { Body } from './thresholds.js';
import { hasOnchainThreshold } from './thresholds.js';
import type { VotingSummary } from '../koios/client.js';

// Re-exported so governance components keep importing the ADA formatters from
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
 * A yes/no/abstain bar from the votes actually CAST: the three inputs are the cast
 * yes/no/abstain quantities (vote power in lovelace for DRep/SPO, member counts for CC).
 * Segments are their shares of the cast total, so non-voting stake is never counted as No.
 * Returns null when nothing was cast (render "no votes", not a bar). Contrast tallyBar,
 * which works off total-stake percentages and folds non-voters into the No side.
 */
export function castVoteBar(
  yes: number | null,
  no: number | null,
  abstain: number | null,
): TallyBar | null {
  const y = yes ?? 0;
  const n = no ?? 0;
  const a = abstain ?? 0;
  const total = y + n + a;
  if (!(total > 0)) return null;
  return { yes: (y / total) * 100, no: (n / total) * 100, abstain: (a / total) * 100 };
}

/** Parses a Koios lovelace power string to a number; null when absent. */
function powerNum(v: string | null | undefined): number | null {
  return v == null ? null : Number(v);
}

/**
 * SPO yes/no percentages for the tally. Koios' pool_yes_pct / pool_no_pct are
 * correct for every action type EXCEPT HardForkInitiation. The Conway ledger does
 * NOT honour the always-abstain reward-account default for hard forks: a pool that
 * did not vote (including one whose reward account delegates to AlwaysAbstain or
 * AlwaysNoConfidence) counts as No and stays in the denominator; only an explicit
 * Abstain vote leaves it. (cardano-ledger Conway Ratify.hs, spoAcceptedRatio:
 * "For HardForkInitiation ... if an SPO didn't vote, their vote will always count
 * as No.") Koios instead drops the always-abstain stake from the denominator for
 * hard forks too, which inflates yes%. For that one type we recompute from the raw
 * power buckets, folding the always-abstain / always-no-confidence stake back into
 * the No side:
 *   yesPct = yes / (yes + no + always_abstain + always_no_confidence)
 * Falls back to Koios' percentages for every other type, and for hard forks when
 * the power fields are absent (older Koios) or the denominator is zero.
 *
 * Lives here (not in tallySync.ts, its only current caller) because the upcoming
 * per-body overview row also needs it and tallySync.ts imports isTerminalStatus
 * from this module; keeping the pure pct math here avoids a circular import
 * between the two.
 */
export function spoTallyPct(s: VotingSummary): { yesPct: number | null; noPct: number | null } {
  const fallback = { yesPct: s.pool_yes_pct ?? null, noPct: s.pool_no_pct ?? null };
  if (s.proposal_type !== 'HardForkInitiation') return fallback;
  const yes = powerNum(s.pool_active_yes_vote_power);
  const no = powerNum(s.pool_no_vote_power);
  if (yes == null || no == null) return fallback;
  const noSide =
    no +
    (powerNum(s.pool_passive_always_abstain_vote_power) ?? 0) +
    (powerNum(s.pool_passive_always_no_confidence_vote_power) ?? 0);
  const denom = yes + noSide;
  if (denom <= 0) return fallback;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return { yesPct: round2((yes / denom) * 100), noPct: round2((noSide / denom) * 100) };
}

/** Color tone for a vote badge. */
export function voteTone(vote: string): StatusTone {
  const v = vote.toLowerCase();
  if (v === 'yes') return 'positive';
  if (v === 'no') return 'negative';
  return 'neutral';
}

// CSS color per tone, owned here next to the tone vocabulary so badges across
// the header, list rows, and vote pills never drift.
export const TONE_COLORS: Record<StatusTone, string> = {
  active: 'var(--accent)',
  positive: '#1a7f37',
  negative: '#c0392b',
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
  // should read as "not yet voted" rather than hostile opposition. See sentimentSubline.
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

/**
 * The sub-line under the sentiment headline. Normally "21% against · 6% abstain";
 * when the No share is only non-voting stake on an open hard fork (see
 * OverviewTally.noIsPending) it reads "84% not yet voted" so the bar does not
 * overstate opposition while voting is still open.
 */
export function sentimentSubline(t: OverviewTally): string {
  const noShare = `${fmtPct(t.bar.no)} ${t.noIsPending ? 'not yet voted' : 'against'}`;
  // A pending bar drops a 0% abstain for a clean "not yet voted"; the normal bar
  // always carries its abstain share, as it did before this relabeling existed.
  if (t.noIsPending && t.bar.abstain === 0) return noShare;
  return `${noShare} · ${fmtPct(t.bar.abstain)} abstain`;
}

export interface StakeParticipation {
  pct: number;          // 0..100
  votedLabel: string;   // "3.21B ₳"
  totalLabel: string;   // "6.66B ₳"
}

/** Turnout from voted vs total DRep voting power (lovelace). Null if no total. */
export function stakeParticipation(votedLovelace: number, totalLovelace: number): StakeParticipation | null {
  if (!Number.isFinite(totalLovelace) || totalLovelace <= 0) return null;
  if (!Number.isFinite(votedLovelace)) return null;
  const pct = Math.min(100, Math.max(0, (votedLovelace / totalLovelace) * 100));
  // Two fraction digits so billions-scale totals stay distinguishable (3.21B vs 3.2B).
  const voted = formatAdaCompact(votedLovelace, 2) ?? '0 ₳';
  const total = formatAdaCompact(totalLovelace, 2) ?? '0 ₳';
  return { pct, votedLabel: voted, totalLabel: total };
}

// The per-body amount fields the gauge breakdown reads. A subset of
// GovernanceAction, so the full action is assignable without a cast. DRep/SPO use
// per-option vote power (lovelace); CC uses member counts (it has no stake).
export interface BodyVoteInput {
  drepYesPower: number | null; drepNoPower: number | null; drepAbstainPower: number | null;
  spoYesPower: number | null; spoNoPower: number | null; spoAbstainPower: number | null;
  ccYes: number | null; ccNo: number | null; ccAbstain: number | null;
}

// Pre-formatted yes/no/abstain amounts for a body: compact ADA for DRep/SPO,
// plain member counts for CC.
export interface VoteAmounts {
  yes: string;
  no: string;
  abstain: string;
}

// Compact ADA amounts (DRep/SPO power, lovelace). A present-but-zero option still
// renders "0 ₳"; only an all-absent body yields null (no tally to show).
function adaAmounts(yes: number | null, no: number | null, abstain: number | null): VoteAmounts | null {
  if (yes == null && no == null && abstain == null) return null;
  return {
    yes: formatAdaCompact(yes ?? 0) ?? '0 ₳',
    no: formatAdaCompact(no ?? 0) ?? '0 ₳',
    abstain: formatAdaCompact(abstain ?? 0) ?? '0 ₳',
  };
}

// CC amounts are member counts, not stake.
function countAmounts(yes: number | null, no: number | null, abstain: number | null): VoteAmounts | null {
  if (yes == null && no == null && abstain == null) return null;
  return { yes: String(yes ?? 0), no: String(no ?? 0), abstain: String(abstain ?? 0) };
}

/**
 * The yes/no/abstain breakdown for one voting body, for the sidebar gauge. DRep
 * and SPO show per-option vote power as compact ADA; CC shows member counts (it
 * has no stake). The gauge fill itself is yesPct (ratification scale, so the
 * threshold marker lines up); these amounts give the stake/seats behind each
 * option. Returns null when the body has no data (e.g. power not yet backfilled).
 */
export function bodyVoteAmounts(a: BodyVoteInput, body: Body): VoteAmounts | null {
  switch (body) {
    case 'DRep':
      return adaAmounts(a.drepYesPower, a.drepNoPower, a.drepAbstainPower);
    case 'SPO':
      return adaAmounts(a.spoYesPower, a.spoNoPower, a.spoAbstainPower);
    case 'CC':
      return countAmounts(a.ccYes, a.ccNo, a.ccAbstain);
  }
}

// The cast-vote + amount fields the advisory (InfoAction) breakdown reads. A subset of
// GovernanceAction, so the full action is assignable without a cast.
export type AdvisoryTallyInput = BodyVoteInput;

export interface AdvisoryBodyTally {
  body: Body;               // 'DRep' | 'SPO' | 'CC'
  label: string;            // human label for the row header
  bar: TallyBar | null;     // null when this body has no synced tally yet
  amounts: VoteAmounts | null;
}

// Fixed body order and labels for the advisory breakdown. DRep first (the richest
// signal), then SPO, then CC.
const ADVISORY_BODIES: readonly { body: Body; label: string }[] = [
  { body: 'DRep', label: 'DReps' },
  { body: 'SPO', label: 'SPOs' },
  { body: 'CC', label: 'Constitutional Committee' },
];

/**
 * Per-body yes/no/abstain tallies for an advisory action (InfoAction), one entry for
 * each of DRep, SPO, CC in fixed order. Unlike overviewTally (which picks a single
 * leading role) this always returns all three bodies so a reader can see how each one
 * voted, including a body addressed by the action text that has not voted yet. Each
 * body's bar comes from the votes actually cast (via castVoteBar), not total-stake
 * percentages, so low-participation actions never render as a false "against" majority.
 * The bar is null when nothing was cast; amounts come from bodyVoteAmounts and are null
 * only when that body's fields were never synced at all.
 */
export function advisoryBodyTallies(a: AdvisoryTallyInput): AdvisoryBodyTally[] {
  return ADVISORY_BODIES.map(({ body, label }) => {
    const bar =
      body === 'DRep'
        ? castVoteBar(a.drepYesPower, a.drepNoPower, a.drepAbstainPower)
        : body === 'SPO'
          ? castVoteBar(a.spoYesPower, a.spoNoPower, a.spoAbstainPower)
          : castVoteBar(a.ccYes, a.ccNo, a.ccAbstain);
    return { body, label, bar, amounts: bodyVoteAmounts(a, body) };
  });
}

// Which of DRep/SPO/CC vote per CIP-1694 for each action type. Mirrors the
// threshold plan() in thresholds.ts, minus the ParameterChange payload nuance
// (touchesSecurity/groups): we do not have the decoded paramScope here, so
// ParameterChange defaults to its always-present bodies (DRep, CC) and the SPO
// seat is picked up dynamically by eligibleBodies() below whenever the action
// actually carries SPO votes (a security-relevant param change was submitted).
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
 * The bodies that vote on this action type (CIP-1694), unioned with any body
 * that actually cast votes (covers the ParameterChange SPO seat, which we
 * cannot statically resolve here without the decoded payload; see
 * ELIGIBLE_BY_TYPE). Returned in fixed DRep, SPO, CC order.
 */
function eligibleBodies(a: RowVotingInput): Body[] {
  const statically = new Set(ELIGIBLE_BY_TYPE[a.type] ?? DEFAULT_ELIGIBLE);
  for (const body of BODY_ORDER) {
    if (bodyHasCastVotes(a, body)) statically.add(body);
  }
  return BODY_ORDER.filter((body) => statically.has(body));
}

// Ratification yes-pct per body: the stored, already-recomputed percentage
// (spoYesPct already reflects the spoTallyPct hard-fork fix from sync time; see
// tallyFields in tallySync.ts). Null when that body's tally has not synced yet.
function ratificationYesPct(a: RowVotingInput, body: Body): number | null {
  switch (body) {
    case 'DRep':
      return a.drepYesPct;
    case 'SPO':
      return a.spoYesPct;
    case 'CC':
      return a.ccYesPct;
  }
}

/** Turnout (0..100) for one body; null when its denominator is unknown or zero. */
function participationFor(
  a: RowVotingInput,
  body: Body,
  opts: { drepStakeTotal: number | null; committeeSize: number | null },
): number | null {
  switch (body) {
    case 'DRep': {
      if (a.drepVotedPower == null || !opts.drepStakeTotal) return null;
      return clampPct((a.drepVotedPower / opts.drepStakeTotal) * 100);
    }
    case 'SPO': {
      if (!a.spoEligiblePower) return null;
      const cast = (a.spoYesPower ?? 0) + (a.spoNoPower ?? 0) + (a.spoAbstainPower ?? 0);
      return clampPct((cast / a.spoEligiblePower) * 100);
    }
    case 'CC': {
      if (!opts.committeeSize) return null;
      const cast = (a.ccYes ?? 0) + (a.ccNo ?? 0) + (a.ccAbstain ?? 0);
      return clampPct((cast / opts.committeeSize) * 100);
    }
  }
}

/** Current-vote bar for one body: ratification pct for threshold types, cast-vote
    shares (advisory) for InfoAction. Null when the underlying data is absent. */
function voteFor(a: RowVotingInput, body: Body, kind: BodyVoteKind): TallyBar | null {
  if (kind === 'ratification') {
    const p = ratificationYesPct(a, body);
    if (p == null) return null;
    const yes = clampPct(p);
    return { yes, no: clampPct(100 - yes), abstain: 0 };
  }
  switch (body) {
    case 'DRep':
      return castVoteBar(a.drepYesPower, a.drepNoPower, a.drepAbstainPower);
    case 'SPO':
      return castVoteBar(a.spoYesPower, a.spoNoPower, a.spoAbstainPower);
    case 'CC':
      return castVoteBar(a.ccYes, a.ccNo, a.ccAbstain);
  }
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
}

export type BodyVoteKind = 'ratification' | 'advisory';

export interface RowBodyVoting {
  body: Body;                   // 'DRep' | 'SPO' | 'CC'
  label: string;                // 'DReps' | 'SPOs' | 'CC'
  participation: number | null; // 0..100 turnout, null when unavailable
  vote: TallyBar | null;        // yes/no(/abstain) bar; null when this body cast nothing
  voteKind: BodyVoteKind;
  amounts: VoteAmounts | null;
}

export interface OverviewRowVoting {
  bodies: RowBodyVoting[]; // only eligible bodies, fixed order DRep, SPO, CC
  absentBodies: Body[];    // bodies that cannot vote on this type (for the note)
}

/**
 * The single leading body's honest current-vote bar for the compact surfaces (OG card).
 * SPO-led types (see isSpoLedType) lead with SPO, all others with DRep; falls back to
 * the next body with a vote, then to any body with a vote. Type-dependent (ratification
 * vs among-cast) exactly as overviewRowVoting, so the share image matches the site.
 * Participation is not needed here (only the per-body vote bar), so the opts are passed
 * as null. Returns null when no eligible body has cast a vote yet.
 */
export function headlineVote(a: RowVotingInput): { bar: TallyBar; role: VoterRole } | null {
  const { bodies } = overviewRowVoting(a, { drepStakeTotal: null, committeeSize: null });
  const order: VoterRole[] = isSpoLedType(a.type) ? ['SPO', 'DRep'] : ['DRep', 'SPO'];
  for (const role of order) {
    const b = bodies.find((x) => x.body === role && x.vote != null);
    if (b?.vote) return { bar: b.vote, role };
  }
  const any = bodies.find((x) => x.vote != null && (x.body === 'DRep' || x.body === 'SPO'));
  return any?.vote ? { bar: any.vote, role: any.body as VoterRole } : null;
}

/**
 * Per-body voting model for the redesigned overview row: one entry per eligible
 * body (DRep/SPO/CC), each with a participation (turnout) percentage and a
 * current-vote bar. The vote bar is type-dependent: action types that carry an
 * on-chain ratification threshold (hasOnchainThreshold) show the ratification
 * percentage split (yes / 100-yes, no abstain segment, matching gov.tools);
 * InfoAction (no threshold) shows the among-cast advisory split instead (via
 * castVoteBar), since there is no ratification percentage to show. absentBodies
 * lists the CIP-1694-expected bodies this type does not use (e.g. SPO for a
 * treasury withdrawal), for the row's "does not vote here" note.
 */
export function overviewRowVoting(
  a: RowVotingInput,
  opts: { drepStakeTotal: number | null; committeeSize: number | null },
): OverviewRowVoting {
  const eligible = eligibleBodies(a);
  const kind: BodyVoteKind = hasOnchainThreshold(a.type) ? 'ratification' : 'advisory';
  const bodies: RowBodyVoting[] = eligible.map((body) => ({
    body,
    label: BODY_LABEL[body],
    participation: participationFor(a, body, opts),
    vote: voteFor(a, body, kind),
    voteKind: kind,
    amounts: bodyVoteAmounts(a, body),
  }));
  // absentBodies are the normally-expected CIP-1694 bodies (the full DRep/SPO/CC
  // set) that are not eligible here, e.g. SPO for a treasury withdrawal. Compared
  // against BODY_ORDER, not ELIGIBLE_BY_TYPE[a.type]: the latter IS the eligible
  // set, so diffing against itself would always be empty.
  const eligibleSet = new Set(eligible);
  const absentBodies = BODY_ORDER.filter((body) => !eligibleSet.has(body));
  return { bodies, absentBodies };
}
