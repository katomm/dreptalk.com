/// <reference types="@cloudflare/workers-types" />
// Render store for per-voter vote rationales on an action. One row per
// (ga_id, voter_id), written by the vote sync (on-chain) and the self-cast path.
import { htmlToText } from '../forum/view.js';

export interface RationaleJob {
  gaId: string;
  voterId: string;
  anchorUrl: string;
  anchorHash: string;
  blockTime: number | null; // unix seconds
}

export async function upsertActionRationale(
  db: D1Database,
  rec: {
    gaId: string;
    voterId: string;
    bodyHtml: string | null;
    source: 'onchain' | 'dreptalk';
    anchorUrl: string | null;
    status: 'ok' | 'empty' | 'failed';
    createdAt: number;
    now: number;
  },
): Promise<void> {
  // Plain-text form for the FTS index. NOT NULL column, so never null: no html
  // yields '', html that strips to nothing yields a single space so the row
  // leaves the backfill's `body_text = ''` candidate set.
  const bodyText = rec.bodyHtml ? htmlToText(rec.bodyHtml) || ' ' : '';
  await db
    .prepare(
      `INSERT INTO action_rationale (ga_id, voter_id, body_html, body_text, source, anchor_url, status, attempts, created_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (ga_id, voter_id) DO UPDATE SET
         body_html = excluded.body_html,
         body_text = excluded.body_text,
         source = excluded.source,
         anchor_url = excluded.anchor_url,
         status = excluded.status,
         attempts = action_rationale.attempts + 1,
         created_at = excluded.created_at,
         fetched_at = excluded.fetched_at`,
    )
    .bind(rec.gaId, rec.voterId, rec.bodyHtml, bodyText, rec.source, rec.anchorUrl, rec.status, rec.createdAt, rec.now)
    .run();
}

/** Renderable rationales for one action, keyed by voter id (body_html present only). */
export async function getActionRationales(
  db: D1Database,
  gaId: string,
): Promise<Map<string, { bodyHtml: string | null; source: string }>> {
  const rows = (
    await db
      .prepare(`SELECT voter_id, body_html, source FROM action_rationale WHERE ga_id = ? AND body_html IS NOT NULL`)
      .bind(gaId)
      .all<{ voter_id: string; body_html: string; source: string }>()
  ).results ?? [];
  const map = new Map<string, { bodyHtml: string | null; source: string }>();
  for (const r of rows) map.set(r.voter_id, { bodyHtml: r.body_html, source: r.source });
  return map;
}

/** Count of readable rationales for one action (cheap; no bodies loaded). */
export async function countActionRationales(db: D1Database, gaId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM action_rationale WHERE ga_id = ? AND body_html IS NOT NULL`)
    .bind(gaId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Retry a failed fetch at most this many times, and not within this window.
const MAX_ATTEMPTS = 4;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Above-threshold DRep votes that have an anchor (url + hash) and no successful
 * rationale row yet (or a failed one that is due for a retry). Ordered by power
 * desc so the most significant voters render first. `minPower` is lovelace.
 */
export async function getRationaleFetchQueue(
  db: D1Database,
  opts: { minPower: number; limit: number; now?: number },
): Promise<RationaleJob[]> {
  const now = opts.now ?? Date.now();
  const rows = (
    await db
      .prepare(
        `SELECT v.ga_id AS gaId, v.voter_id AS voterId, v.meta_url AS anchorUrl,
                v.meta_hash AS anchorHash, v.block_time AS blockTime
         FROM drep_votes v
         JOIN dreps d ON d.drep_id = v.voter_id
         LEFT JOIN action_rationale r ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
         WHERE v.voter_role = 'DRep'
           AND v.meta_url IS NOT NULL AND v.meta_url != ''
           AND v.meta_hash IS NOT NULL AND v.meta_hash != ''
           AND CAST(d.voting_power AS INTEGER) >= ?1
           AND (
             r.ga_id IS NULL
             OR (r.status = 'failed' AND r.attempts < ?2 AND r.fetched_at < ?3)
           )
         ORDER BY CAST(d.voting_power AS INTEGER) DESC, v.voter_id
         LIMIT ?4`,
      )
      .bind(opts.minPower, MAX_ATTEMPTS, now - RETRY_AFTER_MS, opts.limit)
      .all<RationaleJob>()
  ).results ?? [];
  return rows;
}
