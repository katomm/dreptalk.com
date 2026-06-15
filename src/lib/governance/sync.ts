// Governance-action sync: discover on-chain actions via Koios and open one
// system thread per new action. Idempotent: actions already in D1 are skipped.
// A failure on one action (bad anchor, etc.) is isolated and does not abort the
// run. Tallies, lifecycle status, and vote badges are a later sync phase.

import type { ProposalListRow } from '../koios/client.js';
import { governanceActionUrl, epochStartMs, resolveNetwork, type CardanoNetwork } from '../config/network.js';
import { readableType, formatAda } from './view.js';
import { fetchAnchorMetadata, META_EXTRACT_VERSION, META_REEXTRACT_MAX_ATTEMPTS } from './metadata.js';
import { renderMarkdown } from '../markdown.js';
import { createTopic, setTopicPostedAt, getAllTopicsByCategory } from '../db/forum.js';
import { activityInsert } from '../db/activity.js';
import {
  getKnownActionIds,
  buildInsertGovernanceAction,
  getActionsNeedingMetaReextract,
  incrementActionMetaAttempts,
  updateActionMetadata,
  getGovTopicsForSubmittedAtBackfill,
  getAllGovernanceActions,
  batchUpdateTrendingScores,
} from '../db/governance.js';
import { trendingOrderKey } from './sort.js';
import { GOVERNANCE_CATEGORY_SLUG } from '../../../config/categories.js';

// System author for gov-sync-created threads.
export const GOV_SYNC_AUTHOR = 'gov-sync';

export interface SyncResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
}

export interface GovSyncDeps {
  koios: { proposalList(limit?: number): Promise<ProposalListRow[]> };
  db: D1Database;
  network: CardanoNetwork;
  now: number;
  /** Slug-suffix source (injected for deterministic tests). */
  rand: () => string;
  /** Anchor fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Composes the first post as Markdown. Everything (including the untrusted
 * abstract and return address) is rendered through renderMarkdown, whose xss
 * allowlist is the backstop against injection.
 */
function composeFirstPostMd(p: ProposalListRow, abstract: string | null, network: CardanoNetwork): string {
  const lines: string[] = [
    `**On-chain governance action** (${readableType(p.proposal_type)}).`,
    '',
    abstract || 'No abstract was provided in the action metadata.',
    '',
  ];
  if (p.return_address) lines.push(`- Proposer return address: \`${p.return_address}\``);
  const dep = formatAda(p.deposit);
  if (dep) lines.push(`- Deposit: ${dep}`);
  if (p.proposed_epoch != null) lines.push(`- Submitted: epoch ${p.proposed_epoch}`);
  if (p.expiration != null) lines.push(`- Expires: epoch ${p.expiration}`);
  lines.push('', `[View in explorer](${governanceActionUrl(network, p.proposal_id)})`);
  return lines.join('\n');
}

export async function syncGovernanceActions(deps: GovSyncDeps): Promise<SyncResult> {
  const { koios, db, network, now, rand, fetchImpl } = deps;

  const proposals = await koios.proposalList();
  const known = await getKnownActionIds(db);
  const cfg = resolveNetwork(network);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of proposals) {
    const id = `${p.proposal_tx_hash}#${p.proposal_index}`;
    if (known.has(id)) {
      skipped++;
      continue;
    }

    try {
      // Fetch + verify the off-chain anchor when present; tolerate failures.
      const anchor =
        p.meta_url && p.meta_hash
          ? await fetchAnchorMetadata(p.meta_url, p.meta_hash, { fetchImpl })
          : { status: 'no-anchor' as const, metadata: null };

      const meta = anchor.metadata;
      // Fallback title includes the proposal index so multiple actions in one
      // transaction (same tx hash) get distinct titles.
      const title =
        meta?.title || `${readableType(p.proposal_type)} (${p.proposal_tx_hash.slice(0, 8)}#${p.proposal_index})`;

      const bodyMd = composeFirstPostMd(p, meta?.abstract ?? null, network);
      const bodyHtml = renderMarkdown(bodyMd);

      // Post date = on-chain submission time (epoch start; ~5-day granularity, always
      // at or before the true submission). Falls back to now when the epoch is unknown.
      const submittedAtMs = p.proposed_epoch != null ? epochStartMs(p.proposed_epoch, cfg) : now;

      // The governance_actions row is committed in the same atomic batch as the
      // topic and first post, so a partial write can never leave an orphan topic
      // (which the next run would re-create as a duplicate).
      await createTopic(db, {
        categorySlug: GOVERNANCE_CATEGORY_SLUG,
        authorId: GOV_SYNC_AUTHOR,
        title,
        bodyMd,
        bodyHtml,
        source: 'governance',
        now,
        postedAt: submittedAtMs,
        rand: rand(),
        batchWith: (topicId) => [
          buildInsertGovernanceAction(db, {
            id,
            proposalId: p.proposal_id,
            type: p.proposal_type,
            title: meta?.title ?? null,
            abstract: meta?.abstract ?? null,
            rationaleHtml: meta?.rationaleHtml ?? null,
            anchorUrl: p.meta_url ?? null,
            anchorHash: p.meta_hash ?? null,
            anchorStatus: anchor.status,
            returnAddress: p.return_address ?? null,
            deposit: p.deposit ?? null,
            submittedEpoch: p.proposed_epoch ?? null,
            expiryEpoch: p.expiration ?? null,
            metaVersion: META_EXTRACT_VERSION,
            topicId,
            now,
          }),
          // The newly discovered action is a feed event. created_at is the
          // submission time (same as the topic's), so the feed and the topic
          // agree on the action's date.
          activityInsert(db, {
            type: 'gov_created',
            topicId,
            payload: { type: p.proposal_type },
            createdAt: submittedAtMs,
          }),
        ],
      });

      created++;
    } catch {
      failed++;
    }
  }

  return { total: proposals.length, created, skipped, failed };
}

export interface MetaBackfillResult {
  scanned: number;
  updated: number;
  failed: number;
}

export interface MetaBackfillDeps {
  db: D1Database;
  now: number;
  /** Anchor fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
  /** Max actions to re-extract this run (bounds anchor fetches per cron tick). */
  limit: number;
}

/**
 * One-time, self-limiting backfill: re-fetches the anchor doc for each action
 * whose stored metadata was produced by an older extractor version (meta_version
 * < META_EXTRACT_VERSION). Uses the same fetchAnchorMetadata pipeline as
 * discovery, so the result is hash-verified and sanitized identically.
 *
 * Bump META_EXTRACT_VERSION in metadata.ts to trigger a new backfill pass.
 *
 * Behavior on failure: if the anchor is unreachable or fails verification, the
 * row's meta_version stays at its old value so the next run retries, and its
 * meta_attempts counter is bumped. Once a row reaches META_REEXTRACT_MAX_ATTEMPTS
 * failures it drops out of the candidate query (a permanently dead anchor stops
 * being retried). If the anchor fetches and parses successfully but contains no
 * rationale/abstract, that is a valid empty extraction: meta_version IS bumped
 * (the row is now current, just empty).
 */
export async function backfillActionMetadata(deps: MetaBackfillDeps): Promise<MetaBackfillResult> {
  const { db, fetchImpl, limit } = deps;
  const candidates = await getActionsNeedingMetaReextract(db, META_EXTRACT_VERSION, limit, META_REEXTRACT_MAX_ATTEMPTS);
  let updated = 0;
  let failed = 0;

  for (const ga of candidates) {
    // anchor_url is guaranteed non-null by the DB query, but guard the type.
    if (!ga.anchorUrl || !ga.anchorHash) {
      failed++;
      await incrementActionMetaAttempts(db, ga.id);
      continue;
    }
    try {
      const result = await fetchAnchorMetadata(ga.anchorUrl, ga.anchorHash, { fetchImpl });
      if (result.status !== 'ok') {
        // Anchor unreachable or failed integrity check: do not bump version,
        // count the failed attempt, and leave the row for the next run to retry
        // (until it exhausts its attempt budget and is given up on).
        failed++;
        await incrementActionMetaAttempts(db, ga.id);
        continue;
      }
      // Successful fetch (even when the doc has no rationale): bump version.
      await updateActionMetadata(db, ga.id, {
        title: result.metadata.title,
        abstract: result.metadata.abstract,
        rationaleHtml: result.metadata.rationaleHtml,
        metaVersion: META_EXTRACT_VERSION,
      });
      updated++;
    } catch {
      failed++;
      await incrementActionMetaAttempts(db, ga.id);
    }
  }

  return { scanned: candidates.length, updated, failed };
}

export interface SubmittedAtBackfillResult {
  scanned: number;
  updated: number;
}

export interface SubmittedAtBackfillDeps {
  db: D1Database;
  network: CardanoNetwork;
  /** Max no-reply topics to inspect per run (bounds the sweep). */
  limit: number;
}

/**
 * Idempotent post-date backfill: for governance topics with no replies, sets the
 * topic and its system post timestamps to the on-chain submission time derived from
 * the stored submitted_epoch. Sweeps our own D1 (not the live Koios list), so the
 * whole backlog is covered, including terminal actions. After the first corrected run
 * it finds everything already at the submission time and updates nothing (no writes),
 * so it is safe to call every sync. preprod and mainnet each self-correct against
 * their own database the next time the worker runs there.
 */
export async function backfillGovTopicSubmittedAt(deps: SubmittedAtBackfillDeps): Promise<SubmittedAtBackfillResult> {
  const { db, network, limit } = deps;
  const cfg = resolveNetwork(network);
  const candidates = await getGovTopicsForSubmittedAtBackfill(db, limit);
  let updated = 0;
  for (const c of candidates) {
    const submittedAtMs = epochStartMs(c.submittedEpoch, cfg);
    if (c.createdAt === submittedAtMs && c.lastPostAt === submittedAtMs) continue;
    await setTopicPostedAt(db, c.topicId, submittedAtMs);
    updated++;
  }
  return { scanned: candidates.length, updated };
}

export interface TrendingRefreshResult {
  scanned: number;
  updated: number;
}

/**
 * Recomputes the materialized trending sort key for every governance action and writes
 * back only the rows whose score changed (only-changed: a settled run writes nothing).
 * Reuses the same two full reads the list page used to run per request, but off the hot
 * path; the page now orders and pages by the stored key in the database.
 *
 * Run last in the 15-minute governance cron so it folds in this run's discoveries,
 * tally/status updates, and post-date corrections. The score's inputs only move on the
 * cron (votes, status) or on a forum reply (post_count, last_post_at), so the stored key
 * stays as fresh as those already are, lagging a between-cron reply by at most one tick.
 */
export async function refreshTrendingScores(deps: { db: D1Database }): Promise<TrendingRefreshResult> {
  const { db } = deps;
  const [actions, topics] = await Promise.all([
    getAllGovernanceActions(db),
    getAllTopicsByCategory(db, GOVERNANCE_CATEGORY_SLUG),
  ]);
  const topicById = new Map(topics.map((t) => [t.id, t]));

  const updates: { id: string; score: number }[] = [];
  for (const action of actions) {
    if (!action.topicId) continue; // an action with no topic is never listed
    const topic = topicById.get(action.topicId);
    if (!topic) continue; // topic deleted or not in the governance category: not listed
    const score = trendingOrderKey({ topic, action });
    // The REAL round-trips exactly, so === detects an unchanged score and skips the write.
    if (action.trendingScore !== null && action.trendingScore === score) continue;
    updates.push({ id: action.id, score });
  }

  await batchUpdateTrendingScores(db, updates);
  return { scanned: actions.length, updated: updates.length };
}
