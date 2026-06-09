/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for drep_votes (on-chain votes that drive per-post badges).
// All queries use .prepare().bind(); never string-concatenated SQL.

export interface VoteInput {
  voterRole: string;
  voterId: string;
  voterHex: string | null;
  vote: string;
}

// Bound parameters per row in the upsert; stays well under the SQLite limit.
const UPSERT_CHUNK = 100;

/**
 * Upserts on-chain votes for one governance action (INSERT OR REPLACE on the
 * (ga_id, voter_id) primary key), chunked. Returns the number of rows written.
 */
export async function upsertVotes(
  db: D1Database,
  gaId: string,
  votes: VoteInput[],
  now: number,
): Promise<number> {
  if (votes.length === 0) return 0;

  for (let i = 0; i < votes.length; i += UPSERT_CHUNK) {
    const chunk = votes.slice(i, i + UPSERT_CHUNK);
    const stmts = chunk.map((v) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(gaId, v.voterRole, v.voterId, v.voterHex, v.vote, now),
    );
    await db.batch(stmts);
  }
  return votes.length;
}

/** One row of a DRep's voting history: the vote plus its action's context. */
export interface DrepVoteHistoryRow {
  ga_id: string;
  vote: string;
  title: string | null;
  type: string;
  status: string;
  decided_epoch: number | null;
  topic_slug: string | null;
}

/**
 * A DRep's on-chain votes (role 'DRep'), joined to the action and (when present)
 * its forum topic for linking, ordered by the action's decided epoch then id.
 * Uses idx_drep_votes_voter. Default limit 20, capped 50.
 */
export async function getDrepVotingHistory(
  db: D1Database,
  voterId: string,
  opts?: { limit?: number; offset?: number },
): Promise<DrepVoteHistoryRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 50);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const rows = (
    await db
      .prepare(
        `SELECT v.ga_id AS ga_id, v.vote AS vote, g.title AS title, g.type AS type,
                g.status AS status, g.decided_epoch AS decided_epoch, t.slug AS topic_slug
         FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         LEFT JOIN topics t ON t.id = g.topic_id
         WHERE v.voter_id = ? AND v.voter_role = 'DRep'
         ORDER BY g.decided_epoch DESC, g.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(voterId, limit, offset)
      .all<DrepVoteHistoryRow>()
  ).results ?? [];
  return rows;
}

/** Count of a DRep's recorded on-chain votes (role 'DRep'). Uses idx_drep_votes_voter. */
export async function countDrepVotes(db: D1Database, voterId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM drep_votes WHERE voter_id = ? AND voter_role = 'DRep'`)
    .bind(voterId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Returns the votes on one action keyed by voter id, for the per-post badge.
 * The thread view matches each post author's drep_id / pool_id / cc_cred here.
 */
export async function getVotesByGaId(
  db: D1Database,
  gaId: string,
): Promise<Map<string, { role: string; vote: string }>> {
  const rows = (
    await db
      .prepare('SELECT voter_id, voter_role, vote FROM drep_votes WHERE ga_id = ?')
      .bind(gaId)
      .all<{ voter_id: string; voter_role: string; vote: string }>()
  ).results ?? [];

  const map = new Map<string, { role: string; vote: string }>();
  for (const r of rows) {
    map.set(r.voter_id, { role: r.voter_role, vote: r.vote });
  }
  return map;
}
