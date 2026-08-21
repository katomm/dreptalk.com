/// <reference types="@cloudflare/workers-types" />
// Render store for per-voter vote rationales on an action. One row per
// (ga_id, voter_id), written by the vote sync (on-chain) and the self-cast path.
import { htmlToText } from '../forum/view.js';
import { liveVoteSql, type ActionVoterRow } from './drepVotes.js';

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

/**
 * Renderable rationales for one action, keyed by voter id (body_html present only).
 * Joined to drep_votes for the voter's role, so a consumer can exclude CC rationales
 * from a DRep-only segment without a second lookup.
 */
export async function getActionRationales(
  db: D1Database,
  gaId: string,
): Promise<Map<string, { bodyHtml: string | null; source: string; voterRole: string }>> {
  const rows = (
    await db
      .prepare(
        `SELECT r.voter_id AS voter_id, r.body_html AS body_html, r.source AS source, v.voter_role AS voter_role
           FROM action_rationale r
           JOIN drep_votes v ON v.ga_id = r.ga_id AND v.voter_id = r.voter_id
          WHERE r.ga_id = ? AND r.body_html IS NOT NULL`,
      )
      .bind(gaId)
      .all<{ voter_id: string; body_html: string; source: string; voter_role: string }>()
  ).results ?? [];
  const map = new Map<string, { bodyHtml: string | null; source: string; voterRole: string }>();
  for (const r of rows) map.set(r.voter_id, { bodyHtml: r.body_html, source: r.source, voterRole: r.voter_role });
  return map;
}

/**
 * Rationale body + fetch status per voter on one action (all statuses), for the
 * CC breakdown's three states (view / unavailable / none). Keyed by voter_id.
 */
export async function getActionRationaleStatuses(
  db: D1Database,
  gaId: string,
): Promise<Map<string, { bodyHtml: string | null; status: string }>> {
  const res = await db
    .prepare('SELECT voter_id, body_html, status FROM action_rationale WHERE ga_id = ?')
    .bind(gaId)
    .all<{ voter_id: string; body_html: string | null; status: string }>();
  const map = new Map<string, { bodyHtml: string | null; status: string }>();
  for (const r of res.results ?? []) map.set(r.voter_id, { bodyHtml: r.body_html, status: r.status });
  return map;
}

/** A DRep vote rationale plus the voter's identity/power, for the Overview highlights. */
export interface RationaleHighlight extends ActionVoterRow {
  body_html: string;
  source: string;
}

/**
 * A balanced set of the strongest DRep rationales on one action, for the Overview
 * "Rationale highlights" section: the top `perVote` Yes and top `perVote` No voters
 * (abstains excluded) who left a rendered rationale, each side ranked by voting
 * power. Showing both sides keeps the highlights from becoming a one-sided echo of
 * whichever way the largest DReps leaned; a side with fewer rationales simply
 * contributes fewer rows. This surfaces the site's unique content (vote rationales)
 * on the canonical Overview URL instead of only on the Votes tab. Joined to dreps
 * for name/avatar/power, returned ordered by power across both sides. Default 2 per side.
 */
export async function getRationaleHighlights(
  db: D1Database,
  gaId: string,
  perVote = 2,
): Promise<RationaleHighlight[]> {
  const capped = Math.min(Math.max(perVote, 1), 5);
  const rows = (
    await db
      .prepare(
        `SELECT voter_id, vote, voting_power, hex, voter_hex, image_url, block_time, body_html, source
         FROM (
           SELECT v.voter_id AS voter_id, v.vote AS vote,
                  d.voting_power AS voting_power, d.hex AS hex, v.voter_hex AS voter_hex,
                  d.image_url AS image_url, v.block_time AS block_time,
                  r.body_html AS body_html, r.source AS source,
                  ROW_NUMBER() OVER (
                    PARTITION BY lower(v.vote)
                    ORDER BY (d.voting_power IS NULL), CAST(d.voting_power AS INTEGER) DESC, v.voter_id
                  ) AS rn
           FROM action_rationale r
           JOIN drep_votes v ON v.ga_id = r.ga_id AND v.voter_id = r.voter_id
                AND v.voter_role = 'DRep' AND ${liveVoteSql('v')}
           LEFT JOIN dreps d ON d.drep_id = v.voter_id
           WHERE r.ga_id = ?1
             AND r.body_html IS NOT NULL AND r.body_html <> ''
             AND lower(v.vote) IN ('yes', 'no')
         )
         WHERE rn <= ?2
         ORDER BY (voting_power IS NULL), CAST(voting_power AS INTEGER) DESC, voter_id`,
      )
      .bind(gaId, capped)
      .all<RationaleHighlight>()
  ).results ?? [];
  return rows;
}

/**
 * Count of readable rationales for one action (cheap, no bodies loaded). Restricted
 * to DRep and SPO voters so a CC rationale (a distinct segment) does not inflate it.
 */
export async function countActionRationales(db: D1Database, gaId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM action_rationale r
         JOIN drep_votes v ON v.ga_id = r.ga_id AND v.voter_id = r.voter_id
        WHERE r.ga_id = ? AND r.body_html IS NOT NULL AND v.voter_role IN ('DRep','SPO')`,
    )
    .bind(gaId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Retry a failed fetch at most this many times, and not within this window.
const MAX_ATTEMPTS = 4;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Above-threshold DRep and SPO votes that have an anchor (url + hash) and no
 * successful rationale row yet (or a failed one that is due for a retry). A row
 * whose stored anchor no longer matches the vote's current anchor is re-fetched
 * too; the vote write path already deletes such rows when it syncs a re-vote
 * (see archiveSupersededVotes), so this branch is a self-healing net for rows
 * that went stale some other way. A failed re-fetch updates anchor_url, so it
 * then falls under the bounded failed-retry branch instead of looping. Ordered
 * by power desc so the most significant voters render first. `minPower` is
 * lovelace; DReps gate on their registered voting power, SPOs on the stake the
 * vote itself carried (voted_power), since pools have no dreps row.
 */
export async function getRationaleFetchQueue(
  db: D1Database,
  opts: { minPower: number; limit: number; now?: number },
): Promise<RationaleJob[]> {
  const now = opts.now ?? Date.now();
  // Cheap presence probe: same WHERE clause as the fetch query, no ORDER BY, no
  // sort. In steady state the queue is empty and the probe short-circuits at the
  // first non-matching row, avoiding the full-scan-plus-sort of the main query
  // (which was the biggest D1 consumer on this worker).
  const probe = await db
    .prepare(
      `SELECT 1 AS hit
         FROM drep_votes v
         LEFT JOIN dreps d ON d.drep_id = v.voter_id
         LEFT JOIN action_rationale r ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
        WHERE v.meta_url IS NOT NULL AND v.meta_url != ''
          AND v.meta_hash IS NOT NULL AND v.meta_hash != ''
          AND (
            (v.voter_role = 'DRep' AND CAST(d.voting_power AS INTEGER) >= ?1)
            OR (v.voter_role = 'SPO' AND v.voted_power >= ?1)
          )
          AND (
            r.ga_id IS NULL
            OR (r.status = 'failed' AND r.attempts < ?2 AND r.fetched_at < ?3)
            OR IFNULL(r.anchor_url, '') <> v.meta_url
          )
        LIMIT 1`,
    )
    .bind(opts.minPower, MAX_ATTEMPTS, now - RETRY_AFTER_MS)
    .first<{ hit: number }>();
  if (!probe) return [];
  const rows = (
    await db
      .prepare(
        `SELECT v.ga_id AS gaId, v.voter_id AS voterId, v.meta_url AS anchorUrl,
                v.meta_hash AS anchorHash, v.block_time AS blockTime
         FROM drep_votes v
         LEFT JOIN dreps d ON d.drep_id = v.voter_id
         LEFT JOIN action_rationale r ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
         WHERE v.meta_url IS NOT NULL AND v.meta_url != ''
           AND v.meta_hash IS NOT NULL AND v.meta_hash != ''
           AND (
             (v.voter_role = 'DRep' AND CAST(d.voting_power AS INTEGER) >= ?1)
             OR (v.voter_role = 'SPO' AND v.voted_power >= ?1)
           )
           AND (
             r.ga_id IS NULL
             OR (r.status = 'failed' AND r.attempts < ?2 AND r.fetched_at < ?3)
             OR IFNULL(r.anchor_url, '') <> v.meta_url
           )
         ORDER BY CASE v.voter_role WHEN 'DRep' THEN CAST(d.voting_power AS INTEGER) ELSE v.voted_power END DESC, v.voter_id
         LIMIT ?4`,
      )
      .bind(opts.minPower, MAX_ATTEMPTS, now - RETRY_AFTER_MS, opts.limit)
      .all<RationaleJob>()
  ).results ?? [];
  return rows;
}
