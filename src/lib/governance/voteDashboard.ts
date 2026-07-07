// Derived figures for the DRep vote dashboard: the action-oriented stats strip
// and the "closing soon" urgency highlight. Pure and unit-tested. The .astro page
// and the client filter script both read isClosingSoon, so the strip's
// closing-soon count and the highlighted rows can never disagree.

/** An action expiring within this many wall-clock days counts as "closing soon". */
export const CLOSING_SOON_DAYS = 2;

/**
 * True when an action closes within CLOSING_SOON_DAYS. daysLeft is the wall-clock
 * days remaining (from epochDaysLeft), null for terminal or no-expiry actions.
 */
export function isClosingSoon(daysLeft: number | null): boolean {
  return daysLeft != null && daysLeft <= CLOSING_SOON_DAYS;
}

export interface VoteDashboardRow {
  voted: boolean;
  daysLeft: number | null;
}

export interface VoteDashboardStats {
  open: number;
  notVoted: number;
  closingSoon: number;
}

/** Counts for the stats strip, derived from the open-actions list. */
export function deriveVoteStats(rows: VoteDashboardRow[]): VoteDashboardStats {
  let notVoted = 0;
  let closingSoon = 0;
  for (const r of rows) {
    if (!r.voted) notVoted++;
    if (isClosingSoon(r.daysLeft)) closingSoon++;
  }
  return { open: rows.length, notVoted, closingSoon };
}
