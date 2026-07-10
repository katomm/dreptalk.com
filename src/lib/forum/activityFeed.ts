/// <reference types="@cloudflare/workers-types" />
// Reads the newest activity events and hydrates them into ready view models for
// the "Latest activity" feed (homepage + /discussions). All hydration is batched
// through existing loaders (getTopicsByIds, getGovernanceActionsByTopicIds,
// loadAuthorIdentities), so there is no N+1. Events whose topic was deleted are
// dropped, so removed content never surfaces in the feed.

import { getActivityPage, type ActivityKind } from '../db/activity.js';
import { getTopicsByIds } from '../db/forum.js';
import { getGovernanceActionsByTopicIds } from '../db/governance.js';
import { loadAuthorIdentities, type AuthorDescriptor } from './author.js';
import { getCategory } from '../../../config/categories.js';

export type ActivityFilter = 'all' | 'governance' | 'comments';

// Tab order + labels for the /discussions feed; the single source of both. The
// 'comments' filter covers all human forum activity (new topics and replies),
// so its tab reads "Discussion", not "Comments" (which would undersell the
// topic-starts it also includes).
export const ACTIVITY_TABS: readonly { filter: ActivityFilter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'governance', label: 'Governance actions' },
  { filter: 'comments', label: 'Discussion' },
];

const VALID_FILTERS = new Set<string>(ACTIVITY_TABS.map((t) => t.filter));

// Default tab/feed: everything, so the feed shows the full picture of what is
// happening across governance and discussion. The "Discussion" tab still narrows
// to human forum activity (topics + replies) for anyone who wants only that.
export const DEFAULT_ACTIVITY_FILTER: ActivityFilter = 'all';

/** Parses the ?filter= param; defaults to the full feed for anything unrecognized. */
export function parseActivityFilter(value: string | null): ActivityFilter {
  return value && VALID_FILTERS.has(value) ? (value as ActivityFilter) : DEFAULT_ACTIVITY_FILTER;
}

export interface ActivityEvent {
  kind: ActivityKind;
  createdAt: number;
  /** Resolved author, or null for system events (gov_created, gov_status). */
  actor: AuthorDescriptor | null;
  topic: {
    title: string;
    slug: string;
    categoryName: string;
    isGovernance: boolean;
  };
  /** Current governance status, for the badge on gov_created / gov_status. */
  governanceStatus: string | null;
  /** The from/to of a gov_status event; null otherwise. */
  statusTransition: { from: string; to: string } | null;
  /** Reply post id for the deep link on reply_created; null otherwise. */
  refPostId: string | null;
}

function parseTransition(payload: string | null): { from: string; to: string } | null {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as { from?: unknown; to?: unknown };
    if (typeof p.from === 'string' && typeof p.to === 'string') return { from: p.from, to: p.to };
  } catch {
    // Malformed payload: treat as no transition rather than throwing in a render path.
  }
  return null;
}

/**
 * Loads one page of activity events as ready view models, newest first, for the
 * given type filter. getActivityPage already excludes deleted-topic events in SQL,
 * so the returned total matches the rows. Hydration is batched (topics, authors,
 * governance). Default limit 20, capped at 50.
 */
export async function loadActivityFeed(
  db: D1Database,
  opts: { filter?: ActivityFilter; limit: number; offset?: number },
): Promise<{ events: ActivityEvent[]; total: number }> {
  const filter = opts.filter ?? DEFAULT_ACTIVITY_FILTER;
  const limit = Math.min(Math.max(opts.limit, 1), 50);
  const offset = Math.max(opts.offset ?? 0, 0);

  const { rows, total } = await getActivityPage(db, { filter, limit, offset });
  if (rows.length === 0) return { events: [], total };

  const topicIds = [...new Set(rows.map((r) => r.topic_id))];
  const topicsById = await getTopicsByIds(db, topicIds);

  // Defensive: a topic deleted between the page query and this read would still be
  // returned by getTopicsByIds; drop those so removed content never renders.
  const live = rows.filter((r) => {
    const t = topicsById.get(r.topic_id);
    return t && !t.deleted;
  });

  const govTopicIds = live
    .filter((r) => topicsById.get(r.topic_id)?.source === 'governance')
    .map((r) => r.topic_id);

  const [identities, govByTopic] = await Promise.all([
    loadAuthorIdentities(db, live.map((r) => r.actor_id)),
    govTopicIds.length ? getGovernanceActionsByTopicIds(db, govTopicIds) : Promise.resolve(new Map()),
  ]);

  const events = live.map((r) => {
    // Non-null: live was filtered to events whose topic is present.
    const t = topicsById.get(r.topic_id)!;
    const gov = govByTopic.get(r.topic_id);
    const transition = r.type === 'gov_status' ? parseTransition(r.payload) : null;
    return {
      kind: r.type,
      createdAt: r.created_at,
      actor: r.actor_id ? identities.describe(r.actor_id) : null,
      topic: {
        title: t.title,
        slug: t.slug,
        categoryName: getCategory(t.category_slug)?.name ?? t.category_slug,
        isGovernance: t.source === 'governance',
      },
      governanceStatus: gov?.status ?? transition?.to ?? null,
      statusTransition: transition,
      refPostId: r.ref_post_id,
    };
  });

  return { events, total };
}
