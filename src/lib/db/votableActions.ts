/// <reference types="@cloudflare/workers-types" />
// Active governance actions left-joined to the viewer's own DRep vote.
// Prepared statements only; never string-interpolated SQL.

export interface VotableActionRow {
  id: string;
  title: string | null;
  type: string;
  status: string;
  expiry_epoch: number | null;
  tally_epoch: number | null;
  slug: string | null;
  viewerVote: string | null;
  viewerStatus: string | null;
}

/**
 * Returns all active governance actions, joined to the viewer DRep's own vote
 * (if any), ordered by expiry_epoch ascending so the soonest-closing actions
 * come first. Ties broken by id for a stable ordering.
 */
export async function getVotableActionsForViewer(
  db: D1Database,
  drepId: string,
): Promise<VotableActionRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT g.id AS id, g.title AS title, g.type AS type, g.status AS status,
                g.expiry_epoch AS expiry_epoch, g.tally_epoch AS tally_epoch,
                t.slug AS slug,
                v.vote AS viewerVote,
                v.local_status AS viewerStatus
         FROM governance_actions g
         LEFT JOIN topics t ON t.id = g.topic_id
         LEFT JOIN drep_votes v ON v.ga_id = g.id AND v.voter_id = ? AND v.voter_role = 'DRep'
         WHERE g.status = 'active'
         ORDER BY g.expiry_epoch ASC, g.id ASC`,
      )
      .bind(drepId)
      .all<VotableActionRow>()
  ).results ?? [];
  return rows;
}
