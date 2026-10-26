/// <reference types="@cloudflare/workers-types" />
// Reads behind the proposer and co-proposer sections of /home: the governance
// actions a return address submitted (from governance_actions, no Koios call on
// page load) and the mandates a co-proposer holds. Server only, the /home island
// receives the rows as plain props.

import { parseAuthors } from './governance.js';
import { getGrantsForProposerActions, listActiveGrantsForCoUser } from './proposerGrants.js';
import { sqlPlaceholders } from './sql.js';
import { getUsersByIds } from './users.js';
import { isTerminalStatus } from '../governance/view.js';
import { proposerName } from '../forum/mandate.js';
import { truncateIdMiddle } from '../forum/view.js';

export interface ProposerActionRow {
  /** governance_actions.id, the `<tx hash>#<index>` form. */
  id: string;
  /** The `gov_action1…` id, once the sync has stored it. */
  proposalId: string | null;
  title: string | null;
  type: string;
  status: string;
  /** Slug of the action's governance thread, null while it has none. */
  topicSlug: string | null;
  /** Not terminal (pending or active), the group invites are allowed in. */
  open: boolean;
  /** The action's CIP-108 authors, the only names an invite may carry as team. */
  authors: string[];
}

/** A pending invite as the /home island shows it (no co-proposer yet). */
export interface PendingInviteView {
  grantId: string;
  createdAt: number;
  expiresAt: number;
  teamLabel: string | null;
}

/** An active co-proposer as the /home island shows it. */
export interface CoProposerView {
  grantId: string;
  coName: string;
  coStakeAddr: string | null;
  since: number | null;
  teamLabel: string | null;
}

/** One row of the /home island: the action plus its grants, plain JSON for hydration. */
export interface ProposerActionView extends ProposerActionRow {
  pending: PendingInviteView[];
  active: CoProposerView[];
}

export interface MandateRow {
  grantId: string;
  actionId: string;
  actionTitle: string | null;
  /** Feeds the untitled fallback (type plus short id). Null when the action row is missing. */
  actionType: string | null;
  topicSlug: string | null;
  /** Registry org name of the inviting proposer, else the shortened stake address. */
  proposerLabel: string;
  teamLabel: string | null;
  since: number | null;
}

interface ActionDbRow {
  id: string;
  proposal_id: string | null;
  title: string | null;
  type: string;
  status: string;
  authors: string | null;
  submitted_at: number | null;
  created_at: number;
  slug: string | null;
}

/**
 * Every governance action whose return address is `stakeAddr`, open ones
 * first, then newest submission first. Actions without a stored submission
 * time sort after dated ones within their group.
 */
export async function listProposerActions(db: D1Database, stakeAddr: string): Promise<ProposerActionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ga.id, ga.proposal_id, ga.title, ga.type, ga.status, ga.authors, ga.submitted_at, ga.created_at, t.slug
         FROM governance_actions ga
         LEFT JOIN topics t ON t.id = ga.topic_id
        WHERE ga.return_address = ?1
        ORDER BY ga.submitted_at IS NULL, ga.submitted_at DESC, ga.created_at DESC, ga.id`,
    )
    .bind(stakeAddr)
    .all<ActionDbRow>();
  const rows = (results ?? []).map(
    (r): ProposerActionRow => ({
      id: r.id,
      proposalId: r.proposal_id,
      title: r.title,
      type: r.type,
      status: r.status,
      topicSlug: r.slug,
      open: !isTerminalStatus(r.status),
      authors: parseAuthors(r.authors) ?? [],
    }),
  );
  // Stable partition keeps the date order inside each group, and the open test
  // stays the single isTerminalStatus definition instead of a SQL copy of it.
  return [...rows.filter((r) => r.open), ...rows.filter((r) => !r.open)];
}

/**
 * The proposer's actions joined with their active and unexpired pending
 * grants and the co-proposers' names, ready for the /home island. The caller
 * has checked that `stakeAddr` belongs to `proposerUserId` (requireGrantManager).
 */
export async function loadProposerActionViews(
  db: D1Database,
  proposerUserId: string,
  stakeAddr: string,
): Promise<ProposerActionView[]> {
  const [actions, grantsByAction] = await Promise.all([
    listProposerActions(db, stakeAddr),
    getGrantsForProposerActions(db, proposerUserId),
  ]);
  const coUserIds = [...grantsByAction.values()]
    .flat()
    .map((g) => (g.status === 'active' ? g.co_user_id : null))
    .filter((id): id is string => id != null);
  const coUsers = coUserIds.length > 0 ? await getUsersByIds(db, coUserIds) : new Map();

  return actions.map((a) => {
    const grants = grantsByAction.get(a.id) ?? [];
    return {
      ...a,
      pending: grants
        .filter((g) => g.status === 'pending')
        .map((g) => ({ grantId: g.id, createdAt: g.created_at, expiresAt: g.expires_at, teamLabel: g.team_label })),
      active: grants
        .filter((g) => g.status === 'active')
        .map((g) => ({
          grantId: g.id,
          coName: (g.co_user_id ? coUsers.get(g.co_user_id)?.display_name : null) || 'Co-proposer',
          coStakeAddr: g.co_stake_addr ? truncateIdMiddle(g.co_stake_addr) : null,
          since: g.redeemed_at,
          teamLabel: g.team_label,
        })),
    };
  });
}

/** The active grants a co-proposer holds, oldest first, with what /home shows for each. */
export async function listMandates(db: D1Database, coUserId: string): Promise<MandateRow[]> {
  const grants = await listActiveGrantsForCoUser(db, coUserId);
  if (grants.length === 0) return [];

  const actionIds = [...new Set(grants.map((g) => g.gov_action_id))];
  const actions = new Map<string, { title: string | null; type: string; slug: string | null }>();
  const CHUNK = 100;
  for (let i = 0; i < actionIds.length; i += CHUNK) {
    const chunk = actionIds.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT ga.id, ga.title, ga.type, t.slug
           FROM governance_actions ga
           LEFT JOIN topics t ON t.id = ga.topic_id
          WHERE ga.id IN (${sqlPlaceholders(chunk)})`,
      )
      .bind(...chunk)
      .all<{ id: string; title: string | null; type: string; slug: string | null }>();
    for (const r of results ?? []) actions.set(r.id, { title: r.title, type: r.type, slug: r.slug });
  }

  return grants.map((g) => {
    const action = actions.get(g.gov_action_id);
    return {
      grantId: g.id,
      actionId: g.gov_action_id,
      actionTitle: action?.title ?? null,
      actionType: action?.type ?? null,
      topicSlug: action?.slug ?? null,
      proposerLabel: proposerName(g),
      teamLabel: g.team_label,
      since: g.redeemed_at,
    };
  });
}
