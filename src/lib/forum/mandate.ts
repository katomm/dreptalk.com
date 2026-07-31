/// <reference types="@cloudflare/workers-types" />
// Mandate badge labels for co-proposer-authorized topics and posts: resolves
// each persisted proposer_grant_id to a "for <name>" label at read time. The
// label is driven entirely by the grant row a post/topic was written with, so
// it stays historically accurate even after the grant is later revoked or the
// author's own session state changes.

import { getGrantsByIds, type ProposerGrant } from '../db/proposerGrants.js';
import { proposerView } from '../identity/proposer.js';
import { truncateId } from './view.js';

/** Curated name when known, else the truncated stake address; no declared-name
 * fallback (grants carry no CIP-108 author names). */
function labelFor(grant: ProposerGrant): string {
  const view = proposerView(grant.proposer_stake_addr);
  const name = view.kind === 'known' ? view.name : truncateId(grant.proposer_stake_addr, 18);
  return `for ${name}`;
}

/**
 * Batch-resolves grant ids to badge labels. Dedupes and drops null/undefined
 * ids before querying; returns an empty Map with zero D1 queries when nothing
 * is left. Revoked grants resolve exactly like active ones (attribution is
 * historical, not a claim about the grant's current status).
 *
 * `fetchGrants` is injectable for testing the mapping/dedup logic without D1;
 * callers outside tests always use the default.
 */
export async function loadMandates(
  db: D1Database,
  grantIds: (string | null | undefined)[],
  fetchGrants: (db: D1Database, ids: readonly string[]) => Promise<Map<string, ProposerGrant>> = getGrantsByIds,
): Promise<Map<string, string>> {
  const ids = [...new Set(grantIds.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  const grants = await fetchGrants(db, ids);
  for (const [id, grant] of grants) out.set(id, labelFor(grant));
  return out;
}
