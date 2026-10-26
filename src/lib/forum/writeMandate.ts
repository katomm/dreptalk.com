/// <reference types="@cloudflare/workers-types" />
// Per-write co-proposer mandate resolution. A grant names one governance
// action, so a write is stamped with a grant only in that action's thread, or
// in Proposal Drafts (a draft has no action yet, so the proposer is chosen).
// Every call reads D1, which makes a revoked grant stop working at the next
// write. Nothing here looks at the session's roles: a found grant is its own
// authority, and without one the caller applies the usual writer rules.

import { PROPOSAL_DRAFTS_CATEGORY_SLUG } from '../../../config/categories.js';
import { getActiveGrantForAction, listActiveGrantsForCoUser } from '../db/proposerGrants.js';
import { getGovernanceActionByTopicId } from '../db/governance.js';
import { proposerView } from '../identity/proposer.js';
import { truncateId } from './view.js';

/** Who a Proposal Drafts write speaks for: the writer alone, or one of their proposers. */
export type ActAs = 'self' | { proposerStakeAddr: string };

export type MandateResult = { grantId: string } | { grantId: null } | { error: 'choose_proposer' };

/**
 * Reads the client's actAs field strictly: exactly 'self', or a plain object
 * holding nothing but a non-empty proposerStakeAddr string. Anything else is
 * treated as absent.
 */
export function parseActAs(raw: unknown): ActAs | undefined {
  if (raw === 'self') return 'self';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'proposerStakeAddr') return undefined;
  const addr = (raw as { proposerStakeAddr: unknown }).proposerStakeAddr;
  return typeof addr === 'string' && addr.length > 0 ? { proposerStakeAddr: addr } : undefined;
}

/**
 * The Proposal Drafts choice. 'self' takes no mandate. A proposer choice takes
 * the oldest active grant of this user from that proposer, else none, so a
 * forged address borrows nothing. Without a choice, grants from exactly one
 * proposer pick its oldest grant and grants from several need a choice.
 */
async function resolveDraftMandate(db: D1Database, userId: string, actAs: ActAs | undefined): Promise<MandateResult> {
  if (actAs === 'self') return { grantId: null };
  // Oldest first, so the first match per proposer is its oldest grant.
  const grants = await listActiveGrantsForCoUser(db, userId);
  if (actAs !== undefined) {
    const hit = grants.find((g) => g.proposer_stake_addr === actAs.proposerStakeAddr);
    return { grantId: hit ? hit.id : null };
  }
  if (grants.length === 0) return { grantId: null };
  const proposers = new Set(grants.map((g) => g.proposer_stake_addr));
  if (proposers.size > 1) return { error: 'choose_proposer' };
  return { grantId: grants[0].id };
}

/**
 * The grant a reply by this user in this topic is stamped with. In the thread
 * of a governance action that is the user's active grant for exactly that
 * action, actAs plays no part there. In Proposal Drafts the choice rule
 * applies. Everywhere else no mandate.
 */
export async function resolvePostMandate(
  db: D1Database,
  userId: string,
  topic: { id: string; category_slug: string },
  actAs?: ActAs,
): Promise<MandateResult> {
  if (topic.category_slug === PROPOSAL_DRAFTS_CATEGORY_SLUG) return resolveDraftMandate(db, userId, actAs);
  const action = await getGovernanceActionByTopicId(db, topic.id);
  if (!action) return { grantId: null };
  const grant = await getActiveGrantForAction(db, userId, action.id);
  return { grantId: grant ? grant.id : null };
}

/** The grant a new topic is stamped with: only Proposal Drafts takes a mandate. */
export async function resolveTopicMandate(
  db: D1Database,
  userId: string,
  categorySlug: string,
  actAs?: ActAs,
): Promise<MandateResult> {
  if (categorySlug !== PROPOSAL_DRAFTS_CATEGORY_SLUG) return { grantId: null };
  return resolveDraftMandate(db, userId, actAs);
}

/**
 * The distinct proposers behind this user's active grants, oldest grant
 * first, for the composer's proposer choice. The label follows the mandate
 * badge: curated name when known, else the shortened stake address.
 */
export async function mandateProposers(
  db: D1Database,
  userId: string,
): Promise<{ proposerStakeAddr: string; label: string }[]> {
  const grants = await listActiveGrantsForCoUser(db, userId);
  const out: { proposerStakeAddr: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const g of grants) {
    if (seen.has(g.proposer_stake_addr)) continue;
    seen.add(g.proposer_stake_addr);
    const view = proposerView(g.proposer_stake_addr);
    const label = view.kind === 'known' ? view.name : truncateId(g.proposer_stake_addr, 18);
    out.push({ proposerStakeAddr: g.proposer_stake_addr, label });
  }
  return out;
}
