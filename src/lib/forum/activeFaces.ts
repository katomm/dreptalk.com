/// <reference types="@cloudflare/workers-types" />
// View-model builder for the RecentlyActiveCard faces: takes the top active
// DRep/SPO rows (with their role stats) and hydrates names/avatars/profile
// links, formatting the hover-card fields. Shared by the landing and
// discussions pages so both build the faces identically.

import { listActiveGovFaces } from '../db/activeParticipants.js';
import { type AuthorDescriptor, authorProfileHref, loadAuthorIdentities } from './author.js';
import { formatAdaCompact, formatRelativeTime } from './view.js';

export interface ActiveFace {
  author: AuthorDescriptor;
  href: string;
  /** Relative "last seen", e.g. "2d ago". */
  lastActive: string;
  /** Primary role badge ("DRep" / "SPO"), or null. */
  role: string | null;
  /** DRep voting power, already formatted (e.g. "12.5M ADA"), else null. */
  votingPower: string | null;
  /** DRep delegator count, else null. */
  delegators: number | null;
  /** SPO pool ticker, else null. */
  ticker: string | null;
}

/**
 * Ordered active-DRep/SPO faces (newest first) with the hover-card stats
 * resolved. Faces whose profile page does not resolve are dropped, so the
 * caller can fold the remainder into a "+N" tail against the total actor count.
 */
export async function loadActiveFaces(
  db: D1Database,
  cutoffMs: number,
  limit: number,
  nowMs: number,
): Promise<ActiveFace[]> {
  const rows = await listActiveGovFaces(db, cutoffMs, limit);
  if (!rows.length) return [];
  const identities = await loadAuthorIdentities(
    db,
    rows.map((r) => r.id),
  );
  return rows
    .map((r): ActiveFace | null => {
      const author = identities.describe(r.id);
      const href = authorProfileHref(author);
      if (!href) return null;
      return {
        author,
        href,
        lastActive: formatRelativeTime(r.lastSeen, nowMs),
        role: author.badges?.[0] ?? null,
        votingPower: r.isDrep && r.votingPower ? formatAdaCompact(r.votingPower) : null,
        delegators: r.isDrep ? r.delegatorCount : null,
        ticker: r.isSpo ? r.poolTicker : null,
      };
    })
    .filter((f): f is ActiveFace => f !== null);
}
