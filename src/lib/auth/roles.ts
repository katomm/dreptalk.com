// Role predicates over a session's roles array (locals.user.roles). The role
// strings are issued at login: on-chain roles 'drep' | 'spo' | 'cc' | 'proposer',
// the moderation roles 'admin' | 'moderator', and the fallback 'member'.

/** On-chain roles that prove a wallet-verified governance identity. */
export const WRITER_ROLES = ['drep', 'spo', 'cc', 'proposer'] as const;

/** Moderation roles granted via the operator allowlist. */
export const MODERATOR_ROLES = ['admin', 'moderator'] as const;

/**
 * True when the user holds at least one on-chain writer role. These are the
 * users allowed to post and to flag posts; the wallet-proven identity (and, for
 * DReps, the on-chain deposit) is what makes participation accountable.
 */
export function isWriter(roles: readonly string[]): boolean {
  return roles.some((r) => (WRITER_ROLES as readonly string[]).includes(r));
}

/** True when the user holds a moderation role (admin or moderator). */
export function isModerator(roles: readonly string[]): boolean {
  return roles.some((r) => (MODERATOR_ROLES as readonly string[]).includes(r));
}
