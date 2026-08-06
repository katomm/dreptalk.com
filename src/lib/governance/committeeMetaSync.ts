/// <reference types="@cloudflare/workers-types" />
// CC-only vote-meta ingestion: for constitutional-committee votes that carry an
// anchor but have no stored rationale yet, fetch the anchor once and store both
// the rendered rationale (action_rationale, read by the Positions tab) and the
// member's self-declared name (cc_member_name). CC votes are excluded from the
// DRep rationale queue (power-gated, role='DRep'), so they need their own pass.
import { fetchAnchorDoc } from './metadata.js';
import { extractVoteRationaleComment } from './voteRationaleAnchor.js';
import { renderMarkdown } from '../markdown.js';
import { namesFromAuthors } from './ccNames.js';
import { upsertCcMemberName, normalizeKeyHex } from '../db/ccMemberName.js';
import { upsertActionRationale } from '../db/actionRationale.js';

const DEFAULT_LIMIT = 40;
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

interface CcMetaJob {
  gaId: string;
  voterId: string;
  voterHex: string;
  anchorUrl: string;
  anchorHash: string;
  blockTime: number | null;
}

/** CC votes with a usable anchor and no resolved rationale yet (or a stale failed
    one, or a changed anchor url). */
async function getCommitteeMetaQueue(db: D1Database, opts: { limit: number; now: number }): Promise<CcMetaJob[]> {
  const res = await db
    .prepare(
      `SELECT v.ga_id AS gaId, v.voter_id AS voterId, v.voter_hex AS voterHex,
              v.meta_url AS anchorUrl, v.meta_hash AS anchorHash, v.block_time AS blockTime
         FROM drep_votes v
         LEFT JOIN action_rationale r ON r.ga_id = v.ga_id AND r.voter_id = v.voter_id
        WHERE v.voter_role = 'ConstitutionalCommittee'
          AND v.voter_hex IS NOT NULL AND v.voter_hex <> ''
          AND v.meta_url IS NOT NULL AND v.meta_url <> ''
          AND v.meta_hash IS NOT NULL AND v.meta_hash <> ''
          AND (
                r.ga_id IS NULL
             OR r.anchor_url IS NOT v.meta_url
             OR (r.status = 'failed' AND r.attempts < ? AND r.fetched_at < ?)
          )
        ORDER BY (v.block_time IS NULL), v.block_time DESC
        LIMIT ?`,
    )
    .bind(MAX_ATTEMPTS, opts.now - RETRY_AFTER_MS, opts.limit)
    .all<CcMetaJob>();
  return res.results ?? [];
}

export interface CommitteeMetaSyncResult { fetched: number; ok: number; named: number; failed: number; }

export async function syncCommitteeVoteMeta(deps: {
  db: D1Database; now: number; fetchImpl?: typeof fetch; limit?: number; paceMs?: number;
}): Promise<CommitteeMetaSyncResult> {
  const { db, now, fetchImpl, paceMs = 0 } = deps;
  const jobs = await getCommitteeMetaQueue(db, { limit: deps.limit ?? DEFAULT_LIMIT, now });
  let ok = 0;
  let named = 0;
  let failed = 0;
  for (const [i, job] of jobs.entries()) {
    if (paceMs > 0 && i > 0) await new Promise((r) => setTimeout(r, paceMs));
    const res = await fetchAnchorDoc(job.anchorUrl, job.anchorHash, { fetchImpl });
    const createdAt = job.blockTime != null ? job.blockTime * 1000 : now;
    if (res.status !== 'ok') {
      await upsertActionRationale(db, { gaId: job.gaId, voterId: job.voterId, bodyHtml: null, source: 'onchain', anchorUrl: job.anchorUrl, status: 'failed', createdAt, now });
      failed++;
      continue;
    }
    // Name FIRST (already sanitized by namesFromAuthors), so a name-write failure
    // never leaves the anchor marked done with the name lost. Skip when block_time
    // is null (never fabricate an on-chain time from worker now).
    const names = namesFromAuthors(res.doc);
    if (names.length > 0 && job.blockTime != null) {
      await upsertCcMemberName(db, { hotKeyHex: normalizeKeyHex(job.voterHex), name: names[0], sourceGaId: job.gaId, sourceBlockTime: job.blockTime, now });
      named++;
    }
    const text = extractVoteRationaleComment(res.doc);
    const bodyHtml = text ? renderMarkdown(text) : null;
    await upsertActionRationale(db, { gaId: job.gaId, voterId: job.voterId, bodyHtml, source: 'onchain', anchorUrl: job.anchorUrl, status: bodyHtml ? 'ok' : 'empty', createdAt, now });
    if (bodyHtml) ok++;
  }
  return { fetched: jobs.length, ok, named, failed };
}
