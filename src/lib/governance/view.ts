// Pure presentation helpers for governance actions: readable type, ADA
// formatting, status badges, epoch countdown, tally bars, and vote tones. No I/O;
// all deterministic and unit-tested. Shared by the gov-sync first-post composer
// and the thread header / list rows. Explorer links live in config/network.ts
// (governanceActionUrl), since they are network-aware.

import { formatAda, formatAdaCompact } from '../format/ada.js';

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
  return tone === 'other' ? '/og.png' : `/og/gov-${tone}.png`;
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
