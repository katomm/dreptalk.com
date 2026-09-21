// Open Proposal Drafts threads: the source list for the "Link a Proposal
// Draft" control on the submit form (/ga/new). "Open" means not deleted, not
// locked, and not already linked to a governance action, the same locked
// state buildDraftLinkStatements (see draftLinks.ts) sets the moment a draft
// is linked. Query pattern mirrors getAllTopicsByCategory in forum.ts, scoped
// further against governance_actions.draft_topic_id.
import { PROPOSAL_DRAFTS_CATEGORY_SLUG } from '../../../config/categories.js';

export interface OpenProposalDraft {
  slug: string;
  title: string;
  authorId: string;
  createdAt: number;
  own: boolean;
}

interface OpenDraftRow {
  slug: string;
  title: string;
  author_id: string;
  created_at: number;
}

/**
 * Open Proposal Drafts threads, own first then newest. Fetched once per page
 * load (an SSR prop, no dedicated route) rather than on every keystroke, so
 * the plain query is fine even though it is not paginated: the category is
 * low-volume, same assumption getAllTopicsByCategory documents.
 */
export async function listOpenProposalDrafts(db: D1Database, viewerId: string): Promise<OpenProposalDraft[]> {
  const rows = await db
    .prepare(
      `SELECT slug, title, author_id, created_at FROM topics
        WHERE category_slug = ?1 AND deleted = 0 AND locked = 0
          AND NOT EXISTS (SELECT 1 FROM governance_actions g WHERE g.draft_topic_id = topics.id)
        ORDER BY CASE WHEN author_id = ?2 THEN 0 ELSE 1 END, created_at DESC`,
    )
    .bind(PROPOSAL_DRAFTS_CATEGORY_SLUG, viewerId)
    .all<OpenDraftRow>();
  return (rows.results ?? []).map((r) => ({
    slug: r.slug,
    title: r.title,
    authorId: r.author_id,
    createdAt: r.created_at,
    own: r.author_id === viewerId,
  }));
}
