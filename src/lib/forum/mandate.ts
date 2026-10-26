/// <reference types="@cloudflare/workers-types" />
// Mandate badge labels for co-proposer-authorized topics and posts: resolves
// each persisted proposer_grant_id to a badge at read time. The
// label is driven entirely by the grant row a post/topic was written with, so
// it stays historically accurate even after the grant is later revoked or the
// author's own session state changes.

import { getGrantsByIds, type ProposerGrant } from '../db/proposerGrants.js';
import { proposerView } from '../identity/proposer.js';
import { sqlPlaceholders } from '../db/sql.js';
import { truncateId } from './view.js';

export interface MandateBadge {
  label: string;
  title: string | null;
}

/** Curated name when known, else the truncated stake address. No declared-name
 * fallback (grants carry no CIP-108 author names). Also labels /home's mandates. */
export function proposerName(grant: ProposerGrant): string {
  const view = proposerView(grant.proposer_stake_addr);
  return view.kind === 'known' ? view.name : truncateId(grant.proposer_stake_addr, 18);
}

/** governance_actions.id -> topic_id for the given actions, chunked like getGrantsByIds. */
async function getActionTopicIds(db: D1Database, ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(`SELECT id, topic_id FROM governance_actions WHERE id IN (${sqlPlaceholders(chunk)})`)
      .bind(...chunk)
      .all<{ id: string; topic_id: string | null }>();
    for (const row of results ?? []) out.set(row.id, row.topic_id);
  }
  return out;
}

/**
 * Batch-resolves grant ids to badges. Dedupes and drops null/undefined ids
 * before querying; returns an empty Map with zero D1 queries when nothing is
 * left. Revoked grants resolve exactly like active ones (attribution is
 * historical, not a claim about the grant's current status).
 *
 * A grant whose action's topic is the topic being rendered reads "Proposer
 * team" (plus the team name), anything else (Proposal Drafts, category lists
 * with a null `renderedTopicId`) keeps "for <Proposer>".
 *
 * `fetchGrants` and `fetchTopicIds` are injectable for testing the mapping
 * logic without D1, callers outside tests use the defaults.
 */
export async function loadMandates(
  db: D1Database,
  grantIds: (string | null | undefined)[],
  renderedTopicId: string | null,
  fetchGrants: (db: D1Database, ids: readonly string[]) => Promise<Map<string, ProposerGrant>> = getGrantsByIds,
  fetchTopicIds: (db: D1Database, ids: readonly string[]) => Promise<Map<string, string | null>> = getActionTopicIds,
): Promise<Map<string, MandateBadge>> {
  const ids = [...new Set(grantIds.filter((id): id is string => !!id))];
  const out = new Map<string, MandateBadge>();
  if (ids.length === 0) return out;

  const grants = await fetchGrants(db, ids);
  let topicByAction = new Map<string, string | null>();
  if (renderedTopicId && grants.size > 0) {
    const actionIds = [...new Set([...grants.values()].map((g) => g.gov_action_id).filter((a): a is string => !!a))];
    topicByAction = await fetchTopicIds(db, actionIds);
  }

  for (const [id, grant] of grants) {
    const name = proposerName(grant);
    const inActionThread =
      !!renderedTopicId && !!grant.gov_action_id && topicByAction.get(grant.gov_action_id) === renderedTopicId;
    out.set(
      id,
      inActionThread
        ? {
            label: grant.team_label ? `Proposer team \u00b7 ${grant.team_label}` : 'Proposer team',
            title: `Invited by ${name}, which submitted this action`,
          }
        : { label: `for ${name}`, title: null },
    );
  }
  return out;
}
