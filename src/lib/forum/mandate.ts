/// <reference types="@cloudflare/workers-types" />
// Mandate badge labels for co-proposer-authorized topics and posts: resolves
// each persisted proposer_grant_id to a badge at read time. The
// label is driven entirely by the grant row a post/topic was written with, so
// it stays historically accurate even after the grant is later revoked or the
// author's own session state changes.

import { getGrantsByIds, type GrantWithTopic, type ProposerGrant } from '../db/proposerGrants.js';
import { proposerView } from '../identity/proposer.js';
import { teamBadgeLabel, truncateId } from './view.js';

export interface MandateBadge {
  label: string;
  title: string | null;
}

/** Curated name when known, else the truncated stake address. Also labels /home's
 * mandates. The team label (a CIP-108 author name) is carried separately on the grant. */
export function proposerName(grant: Pick<ProposerGrant, 'proposer_stake_addr'>): string {
  const view = proposerView(grant.proposer_stake_addr);
  return view.kind === 'known' ? view.name : truncateId(grant.proposer_stake_addr, 18);
}

/**
 * Batch-resolves grant ids to badges in one grants query that also carries
 * each grant's action topic. Dedupes and drops null/undefined ids before
 * querying, and makes zero D1 queries when nothing is left. Revoked grants
 * resolve exactly like active ones (attribution is historical, not a claim
 * about the grant's current status).
 *
 * A grant whose action's topic is the topic being rendered reads "Proposer
 * team" (plus the team name), anything else (Proposal Drafts, category lists
 * with a null `renderedTopicId`) keeps "for <Proposer>".
 *
 * Returns the loaded grants as well, so a page can answer status questions
 * about them (is this grant active for the viewer) without a second read.
 * `fetchGrants` is injectable for testing the mapping logic without D1.
 */
export async function loadMandatesWithGrants(
  db: D1Database,
  grantIds: (string | null | undefined)[],
  renderedTopicId: string | null,
  fetchGrants: (db: D1Database, ids: readonly string[]) => Promise<Map<string, GrantWithTopic>> = getGrantsByIds,
): Promise<{ badges: Map<string, MandateBadge>; grants: Map<string, GrantWithTopic> }> {
  const ids = [...new Set(grantIds.filter((id): id is string => !!id))];
  const badges = new Map<string, MandateBadge>();
  if (ids.length === 0) return { badges, grants: new Map() };

  const grants = await fetchGrants(db, ids);
  for (const [id, grant] of grants) {
    const name = proposerName(grant);
    const inActionThread = !!renderedTopicId && grant.topic_id === renderedTopicId;
    badges.set(
      id,
      inActionThread
        ? { label: teamBadgeLabel(grant.team_label), title: `Invited by ${name}, which submitted this action` }
        : { label: `for ${name}`, title: null },
    );
  }
  return { badges, grants };
}

/** The badges alone, for pages that need nothing else from the grants. */
export async function loadMandates(
  db: D1Database,
  grantIds: (string | null | undefined)[],
  renderedTopicId: string | null,
  fetchGrants?: (db: D1Database, ids: readonly string[]) => Promise<Map<string, GrantWithTopic>>,
): Promise<Map<string, MandateBadge>> {
  return (await loadMandatesWithGrants(db, grantIds, renderedTopicId, fetchGrants)).badges;
}
