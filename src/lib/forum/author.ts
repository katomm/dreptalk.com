/// <reference types="@cloudflare/workers-types" />
// Resolves forum author identities (avatar + display name + role badges) for a
// set of author ids, batch-loading users and dreps in at most two queries (no
// N+1). The thread view uses it today; the category and overview views (Part 3)
// reuse the same resolver instead of duplicating the joins.

import { getUsersByIds, type User } from '../db/users.js';
import { getDrepsByIds, type Drep } from '../db/dreps.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { truncateId } from './view.js';

// The presentational descriptor consumed by the AuthorIdentity component. Kept
// here (not in the component) so it is the shared contract between the resolver
// and any view that renders an author.
export interface AuthorDescriptor {
  /** The raw post/topic author_id. */
  authorId: string;
  /** Display name: the DRep name when known, else a truncated id. */
  displayName: string;
  /** drep id when this author has a synced on-chain DRep, used for the /dreps/<id> profile link. */
  drepId?: string | null;
  /** Content hash of the stored avatar in R2 (drives /api/avatar/<hash>), or null/absent when not stored. */
  imageHash?: string | null;
  /** Stable seed for the identicon fallback: the DRep credential hex when known, else the author id. */
  identiconSeed?: string;
  /** On-chain / forum roles to surface as badges. */
  badges?: string[];
  /** System author (governance source): neutral identity, no avatar lookup. */
  isSystem?: boolean;
}

/** Neutral identity for a system-authored item (e.g. a governance-sourced post). */
export function systemAuthor(authorId: string): AuthorDescriptor {
  return { authorId, displayName: 'System', isSystem: true };
}

/** Derives the role badges from a user's on-chain flags and forum role. */
function roleBadges(u: User | undefined): string[] {
  const badges: string[] = [];
  const onChain: [boolean | undefined, string][] = [
    [u?.is_drep, 'DRep'],
    [u?.is_spo, 'SPO'],
    [u?.is_cc, 'CC'],
    [u?.is_proposer, 'Proposer'],
  ];
  for (const [flag, label] of onChain) {
    if (flag) badges.push(label);
  }
  // Forum role badge shown in addition to the on-chain role(s).
  if (u?.role === 'admin') badges.push('Admin');
  else if (u?.role === 'moderator' || u?.role === 'mod') badges.push('Moderator');
  return badges;
}

/**
 * Builds the descriptor for one author id from the already-batched users/dreps
 * maps. Pure mapping, performs no I/O. The gov-sync system author renders as a
 * neutral identity with no avatar lookup.
 */
export function describeAuthor(
  authorId: string,
  usersById: Map<string, User>,
  drepsById: Map<string, Drep>,
): AuthorDescriptor {
  if (authorId === GOV_SYNC_AUTHOR) return systemAuthor(authorId);

  const u = usersById.get(authorId);
  const drep = u?.drep_id ? drepsById.get(u.drep_id) : undefined;

  return {
    authorId,
    displayName: drep?.name ?? u?.display_name ?? truncateId(authorId),
    drepId: u?.drep_id ?? null,
    imageHash: drep?.imageContentHash ?? null,
    identiconSeed: drep?.hex ?? authorId,
    badges: roleBadges(u),
  };
}

/** A resolver that yields a ready descriptor for any author id, no further I/O. */
export interface AuthorIdentities {
  describe(authorId: string): AuthorDescriptor;
}

/**
 * Batch-loads the users and (where present) dreps for the given author ids and
 * returns a resolver. Exactly two queries at most: one over users, one over
 * dreps. The system author and falsy ids are excluded from the lookups.
 */
export async function loadAuthorIdentities(
  db: D1Database,
  authorIds: (string | null | undefined)[],
): Promise<AuthorIdentities> {
  const ids = [
    ...new Set(
      authorIds.filter((id): id is string => !!id && id !== GOV_SYNC_AUTHOR),
    ),
  ];

  const usersById = ids.length ? await getUsersByIds(db, ids) : new Map<string, User>();

  const drepIds = [
    ...new Set(
      [...usersById.values()]
        .map((u) => u.drep_id)
        .filter((id): id is string => !!id),
    ),
  ];

  const drepsById = drepIds.length
    ? await getDrepsByIds(db, drepIds)
    : new Map<string, Drep>();

  return {
    describe: (authorId: string) => describeAuthor(authorId, usersById, drepsById),
  };
}
