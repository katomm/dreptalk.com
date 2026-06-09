// Pure presentation helpers for governance actions: readable type, ADA
// formatting, status badges, epoch countdown, tally bars, and vote tones. No I/O;
// all deterministic and unit-tested. Shared by the gov-sync first-post composer
// and the thread header / list rows. Explorer links live in config/network.ts
// (governanceActionUrl), since they are network-aware.

// Cardano epochs are 5 days on both mainnet and preprod; used for the countdown.
const EPOCH_DAYS = 5;

/** "TreasuryWithdrawals" -> "Treasury Withdrawals". */
export function readableType(type: string): string {
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** Lovelace string -> "100,000 ADA", or null when absent/non-numeric. */
export function formatAda(lovelace: string | null | undefined): string | null {
  if (!lovelace) return null;
  const n = Number(lovelace);
  if (!Number.isFinite(n)) return null;
  return `${(n / 1_000_000).toLocaleString('en-US')} ADA`;
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

// Lifecycle statuses whose voting window is over and whose outcome is frozen. The
// rest ('active', and the not-yet-synced 'pending') are still open and counting down.
const TERMINAL_STATUSES = new Set(['ratified', 'enacted', 'dropped', 'expired', 'closed']);

/** True when the action's voting window has ended (a frozen, terminal outcome). */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Human countdown to an action's expiry epoch, computed against the epoch at the
 * last tally sync. Returns null when the epochs are unknown or already past
 * (the status badge then carries the outcome).
 */
export function epochCountdown(expiryEpoch: number | null, currentEpoch: number | null): string | null {
  const days = epochDaysLeft(expiryEpoch, currentEpoch);
  if (days == null) return null;
  return `~${days} days left (epoch ${expiryEpoch})`;
}

/**
 * Whole days until an action's expiry epoch, against the epoch at the last tally
 * sync. Null when unknown or already past. The bare number powers the list row's
 * "~N days left" headline (the date and epoch are shown separately there).
 */
export function epochDaysLeft(expiryEpoch: number | null, currentEpoch: number | null): number | null {
  if (expiryEpoch == null || currentEpoch == null) return null;
  if (expiryEpoch <= currentEpoch) return null;
  return (expiryEpoch - currentEpoch) * EPOCH_DAYS;
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

/** Formats a tally percentage: two decimals for tiny non-zero values, else whole. */
export function fmtPct(n: number): string {
  return `${n.toFixed(n > 0 && n < 1 ? 2 : 0)}%`;
}

// Which voter role leads a governance-action overview row. The detail header
// always shows DRep + SPO + CC side by side; the compact row has space for one
// tally, so we pick the role that actually decides the action.
export type VoterRole = 'DRep' | 'SPO';

/**
 * True for action types where stake pool operators are a deciding voting body
 * under CIP-1694: hard-fork initiation, motions of no-confidence, and committee
 * updates (new committee / threshold / term). These lead the overview row with
 * the SPO tally; every other type leads with DRep. (CC-only co-deciders, like
 * treasury withdrawals or constitution updates, still lead with DRep, which is
 * the community signal; the CC tally stays in the detail header.)
 */
export function isSpoLedType(type: string): boolean {
  const tone = govTypeTone(type);
  return tone === 'hardfork' || tone === 'noconfidence' || tone === 'committee';
}

// The per-role tally fields the overview picker reads. A subset of
// GovernanceAction, so the full action is assignable without a cast.
export interface RoleTallyInput {
  type: string;
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
    return { role, bar, voted };
  }
  return null;
}

/** Compact ADA from lovelace: "3.21B ₳" / "12.4M ₳" / "950K ₳" / "0 ₳". */
export function formatAdaShort(lovelace: number): string {
  const ada = lovelace / 1_000_000;
  const sym = '₳';
  if (ada >= 1_000_000_000) return `${(ada / 1_000_000_000).toFixed(2)}B ${sym}`;
  if (ada >= 1_000_000) return `${(ada / 1_000_000).toFixed(1)}M ${sym}`;
  if (ada >= 1_000) return `${Math.round(ada / 1_000)}K ${sym}`;
  return `${Math.round(ada)} ${sym}`;
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
  return { pct, votedLabel: formatAdaShort(votedLovelace), totalLabel: formatAdaShort(totalLovelace) };
}
