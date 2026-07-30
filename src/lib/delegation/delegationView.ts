import type { DelegatorFollowRow } from '@/lib/db/delegatorFollows.js';

export type DelegationView =
  | { kind: 'no-follow' }
  | { kind: 'pending' }
  | { kind: 'drep'; drepId: string; staleError: boolean }
  | { kind: 'abstain'; staleError: boolean }
  | { kind: 'no_confidence'; staleError: boolean }
  | { kind: 'none'; staleError: boolean };

/** Derives the display state from the follow row. staleError = a refresh most
 *  recently failed (refresh_error_at set), but the baseline still stands; the
 *  component then shows a "last confirmed state" hint. */
export function resolveDelegationView(follow: DelegatorFollowRow | null): DelegationView {
  if (!follow) return { kind: 'no-follow' };
  if (follow.resolution_status !== 'resolved' || !follow.delegation_type) return { kind: 'pending' };
  const staleError = follow.refresh_error_at != null;
  if (follow.delegation_type === 'drep' && follow.drep_id) {
    return { kind: 'drep', drepId: follow.drep_id, staleError };
  }
  if (follow.delegation_type === 'abstain') return { kind: 'abstain', staleError };
  if (follow.delegation_type === 'no_confidence') return { kind: 'no_confidence', staleError };
  return { kind: 'none', staleError };
}

const RETIRED_STATUSES = new Set(['deregistered', 'retired']);

/** English status hint for a drep follow, or null when active/normal.
 *  Follows the existing model (active boolean + raw Koios status). */
export function drepStatusHint(active: boolean, status: string): string | null {
  if (active) return null;
  if (RETIRED_STATUSES.has(status.toLowerCase())) {
    return 'This DRep has ended its registration. You should review your delegation.';
  }
  return 'This DRep is currently inactive and may not be participating in votes.';
}
