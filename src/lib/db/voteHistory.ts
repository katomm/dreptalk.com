/// <reference types="@cloudflare/workers-types" />
// Archive of superseded on-chain votes. When the vote sync sees a voter's row
// change (different vote or anchor, strictly newer block_time), the old row is
// copied here together with its rendered rationale body, so the UI can show
// that a vote changed. drep_votes keeps only the current vote.
import type { VoteInput } from './drepVotes.js';

export interface SupersededVote {
  ga_id: string;
  voter_id: string;
  voter_role: string;
  vote: string;
  meta_url: string | null;
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

// 9 binds per history INSERT keeps a chunk of 11 rows under D1's 100-param cap.
const INSERT_CHUNK = 11;

/**
 * Compares incoming (authoritative) votes against the stored rows for one
 * action and archives every replaced row into drep_vote_history, snapshotting
 * the current action_rationale body (it belongs to the old anchor). When the
 * replacing vote carries no anchor, the now-orphaned rationale row is deleted
 * (the body lives on in the history row). Rows with a local_status are skipped:
 * a pending self-cast confirming on chain is not a vote change. Idempotent via
 * INSERT OR IGNORE on the (ga_id, voter_id, block_time) primary key.
 * Returns the number of archived rows. Call BEFORE upsertVotes.
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

  const bodies = new Map(
    ((
      await db
        .prepare(`SELECT voter_id, body_html FROM action_rationale WHERE ga_id = ?`)
        .bind(gaId)
        .all<{ voter_id: string; body_html: string | null }>()
    ).results ?? []).map((r) => [r.voter_id, r.body_html]),
  );

  const toArchive: Array<{ old: ExistingVoteRow; body: string | null }> = [];
  const orphaned: string[] = [];
  for (const v of incoming) {
    const old = byVoter.get(v.voterId);
    if (!old || old.local_status != null) continue;
    if (old.block_time == null || v.blockTime == null || v.blockTime <= old.block_time) continue;
    const changed = old.vote !== v.vote || (old.meta_url ?? '') !== (v.metaUrl ?? '');
    if (!changed) continue;
    toArchive.push({ old, body: bodies.get(v.voterId) ?? null });
    // No anchor on the replacing vote: the stored rationale belongs to a dead
    // vote and must stop rendering as current.
    if (!v.metaUrl && bodies.has(v.voterId)) orphaned.push(v.voterId);
  }
  if (toArchive.length === 0) return 0;

  let archived = 0;
  for (let i = 0; i < toArchive.length; i += INSERT_CHUNK) {
    const chunk = toArchive.slice(i, i + INSERT_CHUNK);
    const results = await db.batch(
      chunk.map(({ old, body }) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO drep_vote_history
               (ga_id, voter_id, voter_role, vote, meta_url, meta_hash, block_time, body_html, superseded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(gaId, old.voter_id, old.voter_role, old.vote, old.meta_url, old.meta_hash, old.block_time, body, now),
      ),
    );
    for (const r of results) archived += r.meta.changes ?? 0;
  }

  for (const voterId of orphaned) {
    await db.prepare(`DELETE FROM action_rationale WHERE ga_id = ? AND voter_id = ?`).bind(gaId, voterId).run();
  }
  return archived;
}

/** All superseded votes of one voter, keyed by ga_id, newest first. */
export async function getVoterVoteHistory(db: D1Database, voterId: string): Promise<Map<string, SupersededVote[]>> {
  const rows = (
    await db
      .prepare(
        `SELECT ga_id, voter_id, voter_role, vote, meta_url, block_time, body_html
         FROM drep_vote_history WHERE voter_id = ? ORDER BY block_time DESC`,
      )
      .bind(voterId)
      .all<SupersededVote>()
  ).results ?? [];
  const map = new Map<string, SupersededVote[]>();
  for (const r of rows) {
    const list = map.get(r.ga_id) ?? [];
    list.push(r);
    map.set(r.ga_id, list);
  }
  return map;
}

/** All superseded votes on one action, keyed by voter_id, newest first. */
export async function getActionVoteHistory(db: D1Database, gaId: string): Promise<Map<string, SupersededVote[]>> {
  const rows = (
    await db
      .prepare(
        `SELECT ga_id, voter_id, voter_role, vote, meta_url, block_time, body_html
         FROM drep_vote_history WHERE ga_id = ? ORDER BY block_time DESC`,
      )
      .bind(gaId)
      .all<SupersededVote>()
  ).results ?? [];
  const map = new Map<string, SupersededVote[]>();
  for (const r of rows) {
    const list = map.get(r.voter_id) ?? [];
    list.push(r);
    map.set(r.voter_id, list);
  }
  return map;
}
