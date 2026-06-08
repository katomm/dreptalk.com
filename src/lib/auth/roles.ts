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

// Human-readable labels for the header's signed-in badge.
const ROLE_DISPLAY: Record<string, string> = {
  drep: 'DRep',
  spo: 'SPO',
  cc: 'CC',
  proposer: 'Proposer',
  admin: 'Admin',
  moderator: 'Moderator',
  member: 'Member',
};

// Badge priority: the governance identity role comes first (it answers "who you
// are"), then moderation privileges, then the plain member fallback.
const ROLE_PRIORITY = ['drep', 'spo', 'cc', 'proposer', 'admin', 'moderator', 'member'] as const;

/**
 * Display labels for the roles a session holds, in priority order. Unknown role
 * strings are ignored; an empty/unknown set falls back to ['Member'].
 */
export function roleLabels(roles: readonly string[]): string[] {
  const known = ROLE_PRIORITY.filter((r) => roles.includes(r)).map((r) => ROLE_DISPLAY[r]);
  return known.length > 0 ? known : [ROLE_DISPLAY.member];
}

/** The single highest-priority display label for a session's roles (the header badge). */
export function roleLabel(roles: readonly string[]): string {
  return roleLabels(roles)[0];
}
