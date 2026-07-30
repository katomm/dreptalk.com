/// <reference types="@cloudflare/workers-types" />
// Archive of superseded on-chain votes. When a vote write sees a voter's row
// change (different vote or anchor, strictly newer block_time), the old row is
// copied here together with its rendered rationale body, so the UI can show
// that a vote changed. drep_votes keeps only the current vote. When the anchor
// changed, the stale action_rationale row is deleted in the same pass (its body
// lives on in the history row); the rationale cron then re-fetches the new
// anchor through its normal "no row yet" path, so a superseded rationale never
// renders as current.
import type { VoteInput } from './drepVotes.js';

export interface SupersededVote {
  ga_id: string;
  voter_id: string;
  voter_role: string;
  vote: string;
  block_time: number;
  body_html: string | null;
}

interface ExistingVoteRow {
  voter_id: string;
  voter_role: string;
  vote: string;
  meta_url: string | null;
  meta_hash: string | null;
  block_time: number | null;
  local_status: string | null;
}

// 9 binds per archived row; 11 rows per multi-row INSERT stays under D1's
// 100-bound-param cap. Deletes bind ga_id + up to IN_CHUNK voter ids.
const INSERT_CHUNK = 11;
const IN_CHUNK = 90;

/**
 * Compares incoming (authoritative) votes against the stored rows for one
 * action and archives every replaced row into drep_vote_history, snapshotting
 * the current action_rationale body (it belongs to the old anchor). When the
 * replacing vote changed or dropped its anchor, the now-stale action_rationale
 * row is deleted too. Rows with a local_status are skipped: a pending self-cast
 * confirming on chain is not a vote change. Idempotent via INSERT OR IGNORE on
 * the (ga_id, voter_id, block_time) primary key. Returns the number of archived
 * rows. Runs inside upsertVotes, before the replacement is written; the hot
 * path (no changes) costs a single SELECT.
 */
export async function archiveSupersededVotes(
  db: D1Database,
  gaId: string,
  incoming: VoteInput[],
  now: number,
): Promise<number> {
  if (incoming.length === 0) return 0;

  const existing = (
    await db
      .prepare(
        `SELECT voter_id, voter_role, vote, meta_url, meta_hash, block_time, local_status
         FROM drep_votes WHERE ga_id = ?`,
      )
      .bind(gaId)
      .all<ExistingVoteRow>()
  ).results ?? [];
  if (existing.length === 0) return 0;
  const byVoter = new Map(existing.map((r) => [r.voter_id, r]));

  const changed: Array<{ old: ExistingVoteRow; anchorChanged: boolean }> = [];
  for (const v of incoming) {
    const old = byVoter.get(v.voterId);
    if (!old || old.local_status != null) continue;
    if (old.block_time == null || v.blockTime == null || v.blockTime <= old.block_time) continue;
    const anchorChanged = (old.meta_url ?? '') !== (v.metaUrl ?? '');
    if (old.vote === v.vote && !anchorChanged) continue;
    changed.push({ old, anchorChanged });
  }
  if (changed.length === 0) return 0;

  // Rationale bodies only for the voters that actually changed (rare).
  const bodies = new Map<string, string | null>();
  const changedIds = changed.map((c) => c.old.voter_id);
  for (let i = 0; i < changedIds.length; i += IN_CHUNK) {
    const chunk = changedIds.slice(i, i + IN_CHUNK);
    const rows = (
      await db
        .prepare(
          `SELECT voter_id, body_html FROM action_rationale
           WHERE ga_id = ?1 AND voter_id IN (${chunk.map((_, k) => `?${k + 2}`).join(', ')})`,
        )
        .bind(gaId, ...chunk)
        .all<{ voter_id: string; body_html: string | null }>()
    ).results ?? [];
    for (const r of rows) bodies.set(r.voter_id, r.body_html);
  }

  // One batch: multi-row archive inserts plus the stale-rationale deletes.
  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < changed.length; i += INSERT_CHUNK) {
    const chunk = changed.slice(i, i + INSERT_CHUNK);
    inserts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO drep_vote_history
             (ga_id, voter_id, voter_role, vote, meta_url, meta_hash, block_time, body_html, superseded_at)
           VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        )
        .bind(
          ...chunk.flatMap(({ old }) => [
            gaId, old.voter_id, old.voter_role, old.vote, old.meta_url, old.meta_hash,
            old.block_time, bodies.get(old.voter_id) ?? null, now,
          ]),
        ),
    );
  }
  const staleIds = changed.filter((c) => c.anchorChanged && bodies.has(c.old.voter_id)).map((c) => c.old.voter_id);
  const deletes: D1PreparedStatement[] = [];
  for (let i = 0; i < staleIds.length; i += IN_CHUNK) {
    const chunk = staleIds.slice(i, i + IN_CHUNK);
    deletes.push(
      db
        .prepare(
          `DELETE FROM action_rationale
           WHERE ga_id = ?1 AND voter_id IN (${chunk.map((_, k) => `?${k + 2}`).join(', ')})`,
        )
        .bind(gaId, ...chunk),
    );
  }
  const results = await db.batch([...inserts, ...deletes]);
  return results.slice(0, inserts.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Superseded votes grouped into a Map, newest first within each group. */
async function groupedHistory(
  db: D1Database,
  whereCol: 'voter_id' | 'ga_id',
  value: string,
  keyOf: (r: SupersededVote) => string,
): Promise<Map<string, SupersededVote[]>> {
  const rows = (
    await db
      .prepare(
        `SELECT ga_id, voter_id, voter_role, vote, block_time, body_html
         FROM drep_vote_history WHERE ${whereCol} = ? ORDER BY block_time DESC`,
      )
      .bind(value)
      .all<SupersededVote>()
  ).results ?? [];
  const map = new Map<string, SupersededVote[]>();
  for (const r of rows) {
    const list = map.get(keyOf(r)) ?? [];
    list.push(r);
    map.set(keyOf(r), list);
  }
  return map;
}

/** All superseded votes of one voter, keyed by ga_id, newest first. */
export function getVoterVoteHistory(db: D1Database, voterId: string): Promise<Map<string, SupersededVote[]>> {
  return groupedHistory(db, 'voter_id', voterId, (r) => r.ga_id);
}

/** All superseded votes on one action, keyed by voter_id, newest first. */
export function getActionVoteHistory(db: D1Database, gaId: string): Promise<Map<string, SupersededVote[]>> {
  return groupedHistory(db, 'ga_id', gaId, (r) => r.voter_id);
}

/** Superseded votes of one voter on one action, newest first. */
export async function getSupersededVotesFor(db: D1Database, voterId: string, gaId: string): Promise<SupersededVote[]> {
  const rows = await db
    .prepare(
      `SELECT ga_id, voter_id, voter_role, vote, block_time, body_html
       FROM drep_vote_history WHERE voter_id = ? AND ga_id = ? ORDER BY block_time DESC`,
    )
    .bind(voterId, gaId)
    .all<SupersededVote>();
  return rows.results ?? [];
}
