// Proposal Drafts links between a governance action and the draft thread its
// CIP-108 references name. Invariant (see the design doc): a draft is linked and
// locked only in a commit where the action already has its governance topic, and
// the lock only fires when the link statement actually took effect.
import { PROPOSAL_DRAFTS_CATEGORY_SLUG } from '../../../config/categories.js';

export interface DraftLinkedAction {
  id: string;
  title: string | null;
  type: string;
  /** Null when the governance thread was deleted: the link and the lock stay, so the row must still render for the unlink button. */
  topicSlug: string | null;
}

/** The first slug that is a live Proposal Drafts thread, as its topic id. */
export async function resolveDraftTopic(db: D1Database, slugs: readonly string[]): Promise<string | null> {
  if (slugs.length === 0) return null;
  // The matcher keeps at most 20 references, so the IN list stays far below the
  // 100 bound-parameter limit.
  const placeholders = slugs.map(() => '?').join(', ');
  const rows =
    (
      await db
        .prepare(`SELECT id, slug FROM topics WHERE slug IN (${placeholders}) AND category_slug = ? AND deleted = 0`)
        .bind(...slugs, PROPOSAL_DRAFTS_CATEGORY_SLUG)
        .all<{ id: string; slug: string }>()
    ).results ?? [];
  for (const slug of slugs) {
    const hit = rows.find((r) => r.slug === slug);
    if (hit) return hit.id;
  }
  return null;
}

/**
 * Link, then lock, as statements for the caller's batch. Placed after the
 * statement that attaches the governance topic, the topic_id guard sees it. The
 * lock re-checks that this action now points at this draft, so a rejected
 * action, an action already linked elsewhere, or one without a topic yet locks
 * nothing.
 */
export function buildDraftLinkStatements(db: D1Database, actionId: string, draftTopicId: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE governance_actions SET draft_topic_id = ?1
          WHERE id = ?2 AND draft_topic_id IS NULL AND draft_link_rejected = 0 AND topic_id IS NOT NULL`,
      )
      .bind(draftTopicId, actionId),
    db
      .prepare(
        `UPDATE topics SET locked = 1
          WHERE id = ?1 AND EXISTS (SELECT 1 FROM governance_actions WHERE id = ?2 AND draft_topic_id = ?1)`,
      )
      .bind(draftTopicId, actionId),
  ];
}

/** Actions linked to a draft, with their governance thread slug, oldest first. */
export async function getDraftLinkedActions(db: D1Database, draftTopicId: string): Promise<DraftLinkedAction[]> {
  const rows =
    (
      await db
        .prepare(
          `SELECT ga.id AS id, ga.title AS title, ga.type AS type,
                  CASE WHEN t.deleted = 0 THEN t.slug END AS topic_slug
             FROM governance_actions ga LEFT JOIN topics t ON t.id = ga.topic_id
            WHERE ga.draft_topic_id = ?
            ORDER BY ga.submitted_epoch, ga.id`,
        )
        .bind(draftTopicId)
        .all<{ id: string; title: string | null; type: string; topic_slug: string | null }>()
    ).results ?? [];
  return rows.map((r) => ({ id: r.id, title: r.title, type: r.type, topicSlug: r.topic_slug }));
}

/** Slug and title of a live draft thread, for the governance sidebar card. */
export async function getDraftTopicRef(db: D1Database, topicId: string): Promise<{ slug: string; title: string } | null> {
  return (
    (await db
      .prepare('SELECT slug, title FROM topics WHERE id = ? AND deleted = 0')
      .bind(topicId)
      .first<{ slug: string; title: string }>()) ?? null
  );
}

/**
 * Reverses one link and flags the action so no later sync links it again. The
 * draft reopens only when no other action still points at it.
 */
export async function unlinkDraftAction(db: D1Database, actionId: string, draftTopicId: string): Promise<boolean> {
  const [unlink] = await db.batch([
    db
      .prepare('UPDATE governance_actions SET draft_topic_id = NULL, draft_link_rejected = 1 WHERE id = ? AND draft_topic_id = ?')
      .bind(actionId, draftTopicId),
    db
      .prepare('UPDATE topics SET locked = 0 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM governance_actions WHERE draft_topic_id = ?1)')
      .bind(draftTopicId),
  ]);
  return (unlink.meta.changes ?? 0) > 0;
}
