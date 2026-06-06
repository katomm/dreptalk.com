// Moderator / admin allowlist.
//
// Authentication is the normal non-custodial wallet flow: a moderator signs the
// login challenge with the stake key of any wallet (the same stake-key path the
// proposer login uses). This module only grants the moderation *authorization*
// on top, by matching the derived stake address against an allowlist.
//
// The allowlist comes from the MODERATORS environment value rather than being
// committed here: this is an open-source repo, so the maintainers' stake
// addresses are kept out of git (consistent with imprint/secrets via env).
//
// Format: comma-separated `stakeAddress` or `stakeAddress:role` entries, where
// role is `admin` or `moderator` (defaults to `moderator`). Example:
//   MODERATORS="stake1abc...:admin, stake1def..."

export type ModeratorRole = 'admin' | 'moderator';

/** Parses the MODERATORS env value into a stake-address to role map. */
export function parseModerators(raw: string | undefined | null): Map<string, ModeratorRole> {
  const map = new Map<string, ModeratorRole>();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const [addr, roleRaw] = entry.split(':').map((s) => s.trim());
    if (!addr) continue;
    map.set(addr, roleRaw === 'admin' ? 'admin' : 'moderator');
  }
  return map;
}
