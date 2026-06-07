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
      // Discovered but not yet verified by a sync; neutral, not a confident "Active".
      return { label: 'Pending', tone: 'neutral' };
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
    default:
      return { label: status.charAt(0).toUpperCase() + status.slice(1), tone: 'neutral' };
  }
}

/**
 * Human countdown to an action's expiry epoch, computed against the epoch at the
 * last tally sync. Returns null when the epochs are unknown or already past
 * (the status badge then carries the outcome).
 */
export function epochCountdown(expiryEpoch: number | null, currentEpoch: number | null): string | null {
  if (expiryEpoch == null || currentEpoch == null) return null;
  if (expiryEpoch <= currentEpoch) return null;
  const days = (expiryEpoch - currentEpoch) * EPOCH_DAYS;
  return `~${days} days left (epoch ${expiryEpoch})`;
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

/** Formats a tally percentage: two decimals for tiny non-zero values, else whole. */
export function fmtPct(n: number): string {
  return `${n.toFixed(n > 0 && n < 1 ? 2 : 0)}%`;
}
