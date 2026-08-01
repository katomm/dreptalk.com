// Governance-action sync: discover on-chain actions via Koios and open one
// system thread per new action. Idempotent: actions already in D1 are skipped.
// A failure on one action (bad anchor, etc.) is isolated and does not abort the
// run. Tallies, lifecycle status, and vote badges are a later sync phase.

import type { ProposalListRow } from '../koios/client.js';
import { governanceActionUrl, epochStartMs, resolveNetwork, type CardanoNetwork } from '../config/network.js';
import { readableType, formatAda } from './view.js';
import { fetchAnchorMetadata, META_EXTRACT_VERSION, META_REEXTRACT_MAX_ATTEMPTS } from './metadata.js';
import { renderMarkdown } from '../markdown.js';
import { createTopic, buildTopicPostedAtStatements, setGovTopicTitleAndBody, getAllTopicsByCategory } from '../db/forum.js';
import { activityInsert, buildSetGovCreatedEventDate } from '../db/activity.js';
import {
  getKnownActionIds,
  buildInsertGovernanceAction,
  getActionsNeedingMetaReextract,
  incrementActionMetaAttempts,
  updateActionMetadata,
  getGovTopicsForSubmittedAtBackfill,
  getGovActionsWithStaleTopicTitle,
  getAllGovernanceActions,
  batchUpdateTrendingScores,
  getActionIdsMissingOnchainPayload,
  updateActionOnchainPayload,
  getActionIdsMissingSubmittedAt,
  updateActionSubmittedAt,
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
 * The on-chain fields the first post renders. Both discovery (from a Koios
 * ProposalListRow) and the metadata backfill (from a stored governance_actions
 * row) build this shape, so the opening post can be re-rendered identically when
 * a late anchor recovery fills in the previously-missing abstract.
 */
interface FirstPostFields {
  proposalType: string;
  returnAddress: string | null;
  deposit: string | null;
  proposedEpoch: number | null;
  expiration: number | null;
  proposalId: string | null;
}

/**
 * Composes the first post as Markdown. Everything (including the untrusted
 * abstract and return address) is rendered through renderMarkdown, whose xss
 * allowlist is the backstop against injection.
 */
function composeFirstPostMd(p: FirstPostFields, abstract: string | null, network: CardanoNetwork): string {
  const lines: string[] = [
    `**On-chain governance action** (${readableType(p.proposalType)}).`,
    '',
    abstract || 'No abstract was provided in the action metadata.',
    '',
  ];
  if (p.returnAddress) lines.push(`- Proposer return address: \`${p.returnAddress}\``);
  const dep = formatAda(p.deposit);
  if (dep) lines.push(`- Deposit: ${dep}`);
  if (p.proposedEpoch != null) lines.push(`- Submitted: epoch ${p.proposedEpoch}`);
  if (p.expiration != null) lines.push(`- Expires: epoch ${p.expiration}`);
  if (p.proposalId) lines.push('', `[View in explorer](${governanceActionUrl(network, p.proposalId)})`);
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

  // Backfill enacted_epoch on actions we already have once it appears on-chain.
  // Guarded (WHERE enacted_epoch IS NULL) so it is a no-op after the first fill.
  const enactedBackfill: D1PreparedStatement[] = [];

  for (const p of proposals) {
    const id = `${p.proposal_tx_hash}#${p.proposal_index}`;
    if (known.has(id)) {
      if (p.enacted_epoch != null) {
        enactedBackfill.push(
          db
            .prepare(`UPDATE governance_actions SET enacted_epoch = ? WHERE id = ? AND enacted_epoch IS NULL`)
            .bind(p.enacted_epoch, id),
        );
      }
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

      const bodyMd = composeFirstPostMd(
        {
          proposalType: p.proposal_type,
          returnAddress: p.return_address ?? null,
          deposit: p.deposit ?? null,
          proposedEpoch: p.proposed_epoch ?? null,
          expiration: p.expiration ?? null,
          proposalId: p.proposal_id,
        },
        meta?.abstract ?? null,
        network,
      );
      const bodyHtml = renderMarkdown(bodyMd);

      // Post date = exact on-chain submission time (block_time). The epoch start is
      // only a fallback (~5-day granularity, always at or before the true submission);
      // stamping it as the post date made actions look days older than they are.
      const submittedAtMs =
        p.block_time != null
          ? p.block_time * 1000
          : p.proposed_epoch != null
            ? epochStartMs(p.proposed_epoch, cfg)
            : now;

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
            authors: meta?.authors ?? null,
            anchorUrl: p.meta_url ?? null,
            anchorHash: p.meta_hash ?? null,
            anchorStatus: anchor.status,
            returnAddress: p.return_address ?? null,
            deposit: p.deposit ?? null,
            submittedEpoch: p.proposed_epoch ?? null,
            submittedAt: p.block_time != null ? p.block_time * 1000 : null,
            expiryEpoch: p.expiration ?? null,
            enactedEpoch: p.enacted_epoch ?? null,
            onchainPayload: p.proposal_description != null ? JSON.stringify(p.proposal_description) : null,
            // Only claim the current extractor version when the anchor actually
            // extracted ok (or there is no anchor to read). A failed fetch leaves
            // the row below current so the metadata backfill retries it later,
            // instead of treating the empty metadata as final and never revisiting.
            metaVersion: anchor.status === 'ok' || anchor.status === 'no-anchor' ? META_EXTRACT_VERSION : 0,
            topicId,
            now,
          }),
          // The newly discovered action is a feed event. created_at is the
          // submission time (same as the topic's), so the feed and the topic
          // agree on the action's date. notified_at is the real detection time
          // (now), so this action counts as new against the notification cursors
          // even when created_at predates them (sync lag, or the epoch-start
          // fallback). The title rides along in the payload so a single-action
          // push can name it without a topic join.
          activityInsert(db, {
            type: 'gov_created',
            topicId,
            payload: { type: p.proposal_type, title },
            createdAt: submittedAtMs,
            notifiedAt: now,
          }),
        ],
      });

      created++;
    } catch {
      failed++;
    }
  }

  if (enactedBackfill.length > 0) await db.batch(enactedBackfill);

  // Backfill payloads for already-known rows discovered before this column existed.
  // Bounded per run; `proposals` is already in memory, so this adds no Koios call.
  // Once every row has a payload the missing-set is empty and the loop is skipped.
  const missing = await getActionIdsMissingOnchainPayload(db);
  let backfilled = 0;
  if (missing.size > 0) {
    for (const p of proposals) {
      if (backfilled >= 50) break;
      const id = `${p.proposal_tx_hash}#${p.proposal_index}`;
      if (missing.has(id) && p.proposal_description != null) {
        await updateActionOnchainPayload(db, id, JSON.stringify(p.proposal_description));
        backfilled++;
      }
    }
  }

  // Backfill exact submission time (block_time) for rows discovered before this
  // column existed. Same in-memory `proposals`, so no extra Koios call; bounded
  // per run and self-limiting once every row has a submitted_at.
  const missingAt = await getActionIdsMissingSubmittedAt(db);
  let filledAt = 0;
  if (missingAt.size > 0) {
    for (const p of proposals) {
      if (filledAt >= 50) break;
      const id = `${p.proposal_tx_hash}#${p.proposal_index}`;
      if (missingAt.has(id) && p.block_time != null) {
        await updateActionSubmittedAt(db, id, p.block_time * 1000);
        filledAt++;
      }
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
      // Successful fetch (even when the doc has no rationale): bump version. The
      // topic title + opening post are reconciled separately by backfillGovTopicTitles,
      // so this stays focused on the action row.
      await updateActionMetadata(db, ga.id, {
        title: result.metadata.title,
        abstract: result.metadata.abstract,
        rationaleHtml: result.metadata.rationaleHtml,
        authors: result.metadata.authors,
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
  /** Max governance topics to inspect per run (bounds the sweep). */
  limit: number;
}

/**
 * Idempotent post-date backfill: sets each governance topic's timestamps (and its
 * gov_created feed event) to the exact on-chain submission time (submitted_at,
 * from Koios block_time), falling back to the submitted_epoch start for rows the
 * sync never got a block_time for. Replied topics are corrected too, but keep
 * their reply-driven last_post_at (list ordering). Sweeps our own D1 (not the
 * live Koios list), so the whole backlog is covered, including terminal actions.
 * After the first corrected run it finds everything already at the submission
 * time and updates nothing (no writes), so it is safe to call every sync. preprod
 * and mainnet each self-correct against their own database the next time the
 * worker runs there.
 */
export async function backfillGovTopicSubmittedAt(deps: SubmittedAtBackfillDeps): Promise<SubmittedAtBackfillResult> {
  const { db, network, limit } = deps;
  const cfg = resolveNetwork(network);
  const candidates = await getGovTopicsForSubmittedAtBackfill(db, limit);
  // Per-topic statements (post + topic + feed event) stay contiguous so each
  // chunked batch corrects whole topics atomically; the guard below can then
  // rely on created_at alone (a topic at its target implies the rest moved with
  // it in the same batch). Chunking bounds statement count per D1 batch while a
  // first run after a target change corrects the entire backlog.
  const corrections: D1PreparedStatement[] = [];
  let updated = 0;
  for (const c of candidates) {
    const submittedAtMs = c.submittedAt ?? epochStartMs(c.submittedEpoch, cfg);
    if (c.createdAt === submittedAtMs) continue;
    corrections.push(
      ...buildTopicPostedAtStatements(db, c.topicId, submittedAtMs),
      buildSetGovCreatedEventDate(db, c.topicId, submittedAtMs),
    );
    updated++;
  }
  const STMTS_PER_TOPIC = 3;
  const CHUNK = 20 * STMTS_PER_TOPIC;
  for (let i = 0; i < corrections.length; i += CHUNK) {
    await db.batch(corrections.slice(i, i + CHUNK));
  }
  return { scanned: candidates.length, updated };
}

export interface TopicTitleBackfillResult {
  scanned: number;
  updated: number;
}

export interface TopicTitleBackfillDeps {
  db: D1Database;
  network: CardanoNetwork;
  /** Max stale-title topics to reconcile per run (bounds the sweep). */
  limit: number;
}

/**
 * Idempotent topic-title reconciliation: for governance topics whose stored action has a
 * real title that differs from the topic's title, sync the topic title and re-render the
 * opening post from the stored action fields + abstract. This corrects topics left on a
 * discovery-time fallback because the anchor failed then (the action title is filled in
 * later by the metadata backfill) as well as older rows recovered by a backfill that
 * updated only the action row. Pure D1 (no Koios/anchor fetch); the slug is left unchanged
 * so links stay valid. Only-changed: once every topic matches its action, this writes
 * nothing, so it is safe to call every sync.
 */
export async function backfillGovTopicTitles(deps: TopicTitleBackfillDeps): Promise<TopicTitleBackfillResult> {
  const { db, network, limit } = deps;
  const candidates = await getGovActionsWithStaleTopicTitle(db, limit);
  let updated = 0;
  for (const ga of candidates) {
    // The query guarantees both, but the types are nullable: guard for safety.
    if (!ga.topicId || ga.title === null) continue;
    const bodyMd = composeFirstPostMd(
      {
        proposalType: ga.type,
        returnAddress: ga.returnAddress,
        deposit: ga.deposit,
        proposedEpoch: ga.submittedEpoch,
        expiration: ga.expiryEpoch,
        proposalId: ga.proposalId,
      },
      ga.abstract,
      network,
    );
    await setGovTopicTitleAndBody(db, {
      topicId: ga.topicId,
      title: ga.title,
      bodyMd,
      bodyHtml: renderMarkdown(bodyMd),
    });
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
