/// <reference types="@cloudflare/workers-types" />
// Content-addressed store for vote rationale documents. Mirrors db/drepMetadata.

import { chunked, D1_MAX_BINDS, sqlPlaceholders } from './sql.js';

export async function putVoteRationale(
  db: D1Database,
  rec: { hash: string; body: string; drepId: string; gaId: string; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO vote_rationale (hash, body, drep_id, ga_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(rec.hash, rec.body, rec.drepId, rec.gaId, rec.createdAt)
    .run();
}

// A hosted document's URL ends in /vote-rationale/<hash>.json on any origin.
const HOSTED_URL_HASH_RE = /\/vote-rationale\/([0-9a-f]{64})\.json$/i;

/**
 * Deletes hosted rationale documents older than `olderThanSec` that no vote
 * anchors. Hosting is unauthenticated, so without this every document that
 * never became a vote would stay forever. A vote anchors a document by its
 * anchor hash (meta_hash, which is the document hash) or, for votes synced
 * before meta_hash capture, by the hosted URL. Superseded votes count too, the
 * vote history still links their rationale. One pass over each vote table finds
 * every anchored hash, the store itself is small, so nothing scans per document.
 * The grace period must outlast the time from hosting to the vote reaching the
 * sync, multisig collection included.
 */
export async function gcVoteRationale(
  db: D1Database,
  args: { olderThanSec: number },
): Promise<{ scanned: number; deleted: number }> {
  const candidates =
    (
      await db
        .prepare('SELECT hash FROM vote_rationale WHERE created_at < ?')
        .bind(args.olderThanSec)
        .all<{ hash: string }>()
    ).results ?? [];
  if (candidates.length === 0) return { scanned: 0, deleted: 0 };

  const anchored = new Set<string>();
  for (const table of ['drep_votes', 'drep_vote_history'] as const) {
    const rows =
      (
        await db
          .prepare(
            `SELECT meta_hash, meta_url FROM ${table}
              WHERE meta_hash IN (SELECT hash FROM vote_rationale)
                 OR instr(meta_url, '/vote-rationale/') > 0`,
          )
          .all<{ meta_hash: string | null; meta_url: string | null }>()
      ).results ?? [];
    for (const r of rows) {
      if (r.meta_hash) anchored.add(r.meta_hash.toLowerCase());
      const m = r.meta_url ? HOSTED_URL_HASH_RE.exec(r.meta_url) : null;
      if (m) anchored.add(m[1].toLowerCase());
    }
  }

  const doomed = candidates.map((c) => c.hash).filter((h) => !anchored.has(h.toLowerCase()));
  for (const ids of chunked(doomed, D1_MAX_BINDS)) {
    await db.prepare(`DELETE FROM vote_rationale WHERE hash IN (${sqlPlaceholders(ids)})`).bind(...ids).run();
  }
  return { scanned: candidates.length, deleted: doomed.length };
}

/** Returns the canonical JSON body for a hash, or null. */
export async function getVoteRationaleBody(db: D1Database, hash: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT body FROM vote_rationale WHERE hash = ?`)
    .bind(hash)
    .first<{ body: string }>();
  return row?.body ?? null;
}

// One voter's vote on one action with its rendered rationale. Backs the shareable
// vote page and its preview-image route. Includes pending (just-voted, optimistic)
// and confirmed votes, but not failed ones; requires a real rationale (status ok,
// non-blank body_text), so callers redirect instead of rendering an empty page.
// votingPower is read as TEXT from voted_power: it is INTEGER lovelace that can
// exceed JS safe range, and represents the power at vote time (not current power).
export interface VoteStatementRow {
  vote: string;
  localStatus: 'pending' | null;
  txHash: string | null;
  votingPower: string | null;
  blockTime: number | null;
  rationaleHtml: string;
  bodyText: string;
  source: string;
  /** On-chain rationale anchor URL (the raw CIP doc); null when the vote carried none. */
  metaUrl: string | null;
}

export async function getVoteStatement(
  db: D1Database,
  args: { gaId: string; voterId: string; role: 'DRep' | 'SPO' },
): Promise<VoteStatementRow | null> {
  const row = await db
    .prepare(
      `SELECT v.vote AS vote, v.local_status AS local_status, v.tx_hash AS tx_hash,
              CAST(v.voted_power AS TEXT) AS voting_power, v.block_time AS block_time,
              v.meta_url AS meta_url,
              r.body_html AS rationale_html, r.body_text AS body_text, r.source AS source
         FROM drep_votes v
         JOIN action_rationale r ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
        WHERE v.ga_id = ? AND v.voter_id = ? AND v.voter_role = ?
          AND (v.local_status IS NULL OR v.local_status = 'pending')
          AND r.status = 'ok' AND trim(r.body_text) <> ''`,
    )
    .bind(args.gaId, args.voterId, args.role)
    .first<{
      vote: string; local_status: string | null; tx_hash: string | null;
      voting_power: string | null; block_time: number | null; meta_url: string | null;
      rationale_html: string; body_text: string; source: string;
    }>();
  if (!row) return null;
  return {
    vote: row.vote,
    localStatus: row.local_status === 'pending' ? 'pending' : null,
    txHash: row.tx_hash,
    votingPower: row.voting_power,
    blockTime: row.block_time,
    rationaleHtml: row.rationale_html,
    bodyText: row.body_text,
    source: row.source,
    metaUrl: row.meta_url,
  };
}
