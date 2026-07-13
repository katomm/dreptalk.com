/// <reference types="@cloudflare/workers-types" />
// Resolves forum author identities (avatar + display name + role badges) for a
// set of author ids, batch-loading users and dreps in at most two queries (no
// N+1). The thread view uses it today; the category and overview views (Part 3)
// reuse the same resolver instead of duplicating the joins.

import { getUsersByIds, type User } from '../db/users.js';
import { getDrepsByIds, type Drep } from '../db/dreps.js';
import { getPoolsByIds, type Pool } from '../db/pools.js';
import type { ActionVoterRow } from '../db/drepVotes.js';
import { drepPath } from '../dreps/profile.js';
import { poolPath } from '../pools/profile.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { truncateId } from './view.js';

// The presentational descriptor consumed by the AuthorIdentity component. Kept
// here (not in the component) so it is the shared contract between the resolver
// and any view that renders an author.
export interface AuthorDescriptor {
  /** The raw post/topic author_id. */
  authorId: string;
  /** Display name, in precedence order: user display_name, then DRep name, then pool name, then ticker, else a truncated id. */
  displayName: string;
  /** drep id when this author has a synced on-chain DRep, used for the profile link. */
  drepId?: string | null;
  /** Assigned profile slug; the profile link prefers it over the raw id. */
  drepSlug?: string | null;
  /** pool id when this author is a stake pool operator, used for the profile link. */
  poolId?: string | null;
  /** Assigned pool profile slug; the profile link prefers it over the raw id. */
  poolSlug?: string | null;
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
  poolsById: Map<string, Pool>,
): AuthorDescriptor {
  if (authorId === GOV_SYNC_AUTHOR) return systemAuthor(authorId);

  const u = usersById.get(authorId);
  const drep = u?.drep_id ? drepsById.get(u.drep_id) : undefined;
  const pool = u?.pool_id ? poolsById.get(u.pool_id) : undefined;

  return {
    authorId,
    displayName:
      u?.display_name ?? drep?.name ?? pool?.name ?? pool?.ticker ?? truncateId(authorId),
    drepId: u?.drep_id ?? null,
    drepSlug: drep?.slug ?? null,
    poolId: u?.pool_id ?? null,
    poolSlug: pool?.slug ?? null,
    imageHash: drep?.imageContentHash ?? pool?.imageContentHash ?? null,
    identiconSeed: drep?.hex ?? pool?.poolHash ?? authorId,
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

  const poolIds = [
    ...new Set(
      [...usersById.values()].map((u) => u.pool_id).filter((id): id is string => !!id),
    ),
  ];
  const poolsById = poolIds.length ? await getPoolsByIds(db, poolIds) : new Map<string, Pool>();

  return {
    describe: (authorId: string) => describeAuthor(authorId, usersById, drepsById, poolsById),
  };
}

/**
 * Public profile link for an author: DReps and pool operators with a synced
 * row have one, and internal links prefer the SEO slug so they never pay the
 * canonical redirect. When an account is both, the DRep link takes
 * precedence. The single source of this rule for every component that links
 * an author (post headers, the account menu).
 */
export function authorProfileHref(a: AuthorDescriptor): string | null {
  if (a.isSystem) return null;
  if (a.drepId) return drepPath({ drepId: a.drepId, slug: a.drepSlug ?? null });
  if (a.poolId) return poolPath({ poolId: a.poolId, slug: a.poolSlug ?? null });
  return null;
}

/**
 * Resolves a single identity (e.g. the header's signed-in user). Without a DB
 * handle it falls back to the pure id-derived defaults, so callers never deal
 * with the batch resolver's internals.
 */
export async function loadAuthorIdentity(
  db: D1Database | undefined,
  authorId: string,
): Promise<AuthorDescriptor> {
  if (!db) return describeAuthor(authorId, new Map(), new Map(), new Map());
  return (await loadAuthorIdentities(db, [authorId])).describe(authorId);
}

/**
 * Builds the descriptor for a governance-action voter row from the already-batched
 * dreps and (optionally) pools maps. Pure mapping, performs no I/O. A nameless DRep
 * falls back to the truncated id so a full bech32 string never overruns a narrow row.
 * Shared by the positions tab and the top-participants sidebar, which render identical
 * rows. When a pools map is supplied and voter_id matches a pool, resolves to the pool
 * identity with a pool profile link (poolId/poolSlug) instead of a DRep one.
 */
export function voterDescriptor(
  v: ActionVoterRow,
  dreps: Map<string, Drep>,
  pools?: Map<string, Pool>,
): AuthorDescriptor {
  const pool = pools?.get(v.voter_id);
  if (pool) {
    return {
      authorId: v.voter_id,
      displayName: pool.name ?? pool.ticker ?? truncateId(v.voter_id),
      poolId: v.voter_id,
      poolSlug: pool.slug ?? null,
      imageHash: pool.imageContentHash ?? null,
      identiconSeed: pool.poolHash ?? v.voter_hex ?? v.voter_id,
      badges: ['SPO'],
    };
  }
  const d = dreps.get(v.voter_id);
  return {
    authorId: v.voter_id,
    displayName: d?.name ?? truncateId(v.voter_id),
    drepId: v.voter_id,
    drepSlug: d?.slug ?? null,
    imageHash: d?.imageContentHash ?? null,
    identiconSeed: d?.hex ?? v.hex ?? v.voter_hex ?? v.voter_id,
    badges: [],
  };
}

/**
 * A DRep row (from the dreps table) as an AuthorDescriptor, for the directory and
 * movers lists. Like voterDescriptor's DRep branch but reads a full Drep row rather
 * than a vote row. Nameless DReps truncate their bech32 id to the short form the
 * forum resolver uses, so a row never shows an unbroken ~58-char token.
 */
export function drepDescriptor(d: Drep): AuthorDescriptor {
  return {
    authorId: d.drepId,
    displayName: d.name ?? truncateId(d.drepId),
    drepId: d.drepId,
    drepSlug: d.slug,
    imageHash: d.imageContentHash,
    identiconSeed: d.hex ?? d.drepId,
    badges: [],
  };
}
