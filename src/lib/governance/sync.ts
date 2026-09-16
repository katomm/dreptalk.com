// Governance-action sync: discover on-chain actions via Koios and open one
// system thread per new action. Idempotent: actions already in D1 are skipped.
// A failure on one action (bad anchor, etc.) is isolated and does not abort the
// run. Tallies, lifecycle status, and vote badges are a later sync phase.

import type { ProposalListRow } from '../koios/client.js';
import {
  governanceActionUrl,
  epochStartMs,
  resolveNetwork,
  type CardanoNetwork,
  type NetworkConfig,
} from '../config/network.js';
import { readableType, formatAda } from './view.js';
import {
  fetchAnchorMetadata,
  META_EXTRACT_VERSION,
  META_REEXTRACT_MAX_ATTEMPTS,
  type AnchorResult,
} from './metadata.js';
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
  getActionsAwaitingTopic,
  buildAttachActionTopic,
  type GovernanceAction,
} from '../db/governance.js';
import { trendingOrderKey } from './sort.js';
import { GOVERNANCE_CATEGORY_SLUG } from '../../../config/categories.js';

// System author for gov-sync-created threads.
export const GOV_SYNC_AUTHOR = 'gov-sync';

export interface SyncResult {
  total: number;
  /** Actions discovered AND given their thread in this run. */
  created: number;
  /** Actions discovered but still waiting for a readable anchor (no thread yet). */
  deferred: number;
  skipped: number;
  failed: number;
}

/**
 * How many times opening a thread may be postponed because the action's anchor
 * is still unreadable. The thread title is the source of the slug, and the slug
 * is frozen at creation, so a thread opened on the fallback title keeps a URL
 * like /t/info-action-375f7ed7-0-... forever even after the real title arrives.
 * Waiting a few cron ticks costs nothing (a fresh action has no votes and no
 * readers yet) and gets the vast majority of slow anchors, IPFS propagation in
 * particular. Past the cap the thread opens on the fallback title anyway: a
 * missing thread is worse than an ugly URL.
 */
export const DEFERRED_TOPIC_MAX_ATTEMPTS = 6;

/**
 * The title for an action whose anchor yielded none, from the action id
 * (`<tx hash>#<index>`). The index is part of it so several actions in one
 * transaction stay distinguishable.
 */
function fallbackActionTitle(type: string, id: string): string {
  const [txHash, index] = id.split('#');
  return `${readableType(type)} (${txHash.slice(0, 8)}#${index})`;
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

/**
 * Whether a failed anchor read was a transport miss that a later attempt may get
 * past. Anything else is a verdict on the document itself (it arrived but failed
 * its hash check, was not JSON, was too large, or the URL is not fetchable), and
 * asking again, through any gateway, cannot turn it into a readable title.
 */
function anchorMayStillAnswer(status: string): boolean {
  return status === 'fetch-failed' || status === 'bad-content-type';
}

/**
 * Re-reads one stored action's anchor document and, on success, stores what it
 * extracted (which also stamps the current extractor version and clears the
 * attempt counter). A failed read counts one attempt against the give-up budget
 * and leaves the row for a later run. A successful read that simply contains no
 * rationale or abstract is still a success, the row is current, just empty.
 */
async function rereadActionAnchor(
  db: D1Database,
  ga: GovernanceAction,
  fetchImpl?: typeof fetch,
): Promise<AnchorResult> {
  const result: AnchorResult =
    ga.anchorUrl && ga.anchorHash
      ? await fetchAnchorMetadata(ga.anchorUrl, ga.anchorHash, { fetchImpl, db })
      : { status: 'unsupported-url', metadata: null };
  if (result.status !== 'ok') {
    await incrementActionMetaAttempts(db, ga.id);
    return result;
  }
  await updateActionMetadata(db, ga.id, {
    title: result.metadata.title,
    abstract: result.metadata.abstract,
    rationaleHtml: result.metadata.rationaleHtml,
    authors: result.metadata.authors,
    references: result.metadata.references,
    metaVersion: META_EXTRACT_VERSION,
  });
  return result;
}

/** The stored-action shape of FirstPostFields, shared by every re-render path. */
function firstPostFieldsFromAction(ga: GovernanceAction): FirstPostFields {
  return {
    proposalType: ga.type,
    returnAddress: ga.returnAddress,
    deposit: ga.deposit,
    proposedEpoch: ga.submittedEpoch,
    expiration: ga.expiryEpoch,
    proposalId: ga.proposalId,
  };
}

/**
 * The post date of a governance thread: the exact on-chain submission time
 * (block_time). The epoch start is only a fallback (~5-day granularity, always
 * at or before the true submission); stamping it made actions look days older
 * than they are. Both paths that open a thread use this, so a thread that waited
 * for its anchor carries the same date as one opened at discovery.
 */
function govPostedAtMs(
  submittedAtMs: number | null,
  submittedEpoch: number | null,
  cfg: NetworkConfig,
  now: number,
): number {
  if (submittedAtMs != null) return submittedAtMs;
  return submittedEpoch != null ? epochStartMs(submittedEpoch, cfg) : now;
}

/**
 * Opens one governance thread: the system topic, its rendered first post, and the
 * gov_created feed event, plus whatever statement links the action to the new topic
 * (the action INSERT at discovery, an UPDATE when the thread was held back). All of
 * it commits in one atomic batch, so a partial write can never leave an orphan topic
 * that the next run would re-create as a duplicate.
 *
 * created_at on the event is the submission time (same as the topic's), so the feed
 * and the topic agree on the action's date. notified_at is the real detection time,
 * so the action counts as new against the notification cursors even when created_at
 * predates them (sync lag, the epoch-start fallback, or a thread that waited for its
 * anchor). The title rides along in the payload so a single-action push can name it
 * without a topic join.
 */
async function openGovActionTopic(
  db: D1Database,
  a: {
    type: string;
    title: string;
    bodyMd: string;
    postedAt: number;
    now: number;
    rand: string;
    /** Statement linking the action row to the topic this creates. */
    link: (topicId: string) => D1PreparedStatement;
  },
): Promise<void> {
  await createTopic(db, {
    categorySlug: GOVERNANCE_CATEGORY_SLUG,
    authorId: GOV_SYNC_AUTHOR,
    title: a.title,
    bodyMd: a.bodyMd,
    bodyHtml: renderMarkdown(a.bodyMd),
    source: 'governance',
    now: a.now,
    postedAt: a.postedAt,
    rand: a.rand,
    batchWith: (topicId) => [
      a.link(topicId),
      activityInsert(db, {
        type: 'gov_created',
        topicId,
        payload: { type: a.type, title: a.title },
        createdAt: a.postedAt,
        notifiedAt: a.now,
      }),
    ],
  });
}

export async function syncGovernanceActions(deps: GovSyncDeps): Promise<SyncResult> {
  const { koios, db, network, now, rand, fetchImpl } = deps;

  const proposals = await koios.proposalList();
  const known = await getKnownActionIds(db);
  const cfg = resolveNetwork(network);

  let created = 0;
  let deferred = 0;
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
          ? await fetchAnchorMetadata(p.meta_url, p.meta_hash, { fetchImpl, db })
          : { status: 'no-anchor' as const, metadata: null };

      const meta = anchor.metadata;
      const anchorRead = anchor.status === 'ok' || anchor.status === 'no-anchor';
      const submittedAtMs = p.block_time != null ? p.block_time * 1000 : null;

      const insertAction = (topicId: string | null) =>
        buildInsertGovernanceAction(db, {
          id,
          proposalId: p.proposal_id,
          type: p.proposal_type,
          title: meta?.title ?? null,
          abstract: meta?.abstract ?? null,
          rationaleHtml: meta?.rationaleHtml ?? null,
          authors: meta?.authors ?? null,
          references: meta?.references ?? null,
          anchorUrl: p.meta_url ?? null,
          anchorHash: p.meta_hash ?? null,
          anchorStatus: anchor.status,
          returnAddress: p.return_address ?? null,
          deposit: p.deposit ?? null,
          submittedEpoch: p.proposed_epoch ?? null,
          submittedAt: submittedAtMs,
          expiryEpoch: p.expiration ?? null,
          enactedEpoch: p.enacted_epoch ?? null,
          onchainPayload: p.proposal_description != null ? JSON.stringify(p.proposal_description) : null,
          // Only claim the current extractor version when the anchor actually
          // extracted ok (or there is no anchor to read). A failed fetch leaves
          // the row below current so the metadata backfill retries it later,
          // instead of treating the empty metadata as final and never revisiting.
          metaVersion: anchorRead ? META_EXTRACT_VERSION : 0,
          topicId,
          now,
        });

      // An anchor that did not answer means no real title yet, and the slug built from
      // the fallback would be permanent (see DEFERRED_TOPIC_MAX_ATTEMPTS). Store the
      // action alone and let createDeferredGovTopics open the thread once the anchor
      // answers. A document that did arrive (titleless, or failing its checks) is NOT
      // deferred: retrying it would never produce a better title.
      if (!meta?.title && anchorMayStillAnswer(anchor.status)) {
        await insertAction(null).run();
        deferred++;
        continue;
      }

      await openGovActionTopic(db, {
        type: p.proposal_type,
        title: meta?.title || fallbackActionTitle(p.proposal_type, id),
        bodyMd: composeFirstPostMd(
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
        ),
        postedAt: govPostedAtMs(submittedAtMs, p.proposed_epoch ?? null, cfg, now),
        now,
        rand: rand(),
        link: insertAction,
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

  return { total: proposals.length, created, deferred, skipped, failed };
}

export interface DeferredTopicResult {
  scanned: number;
  /** Actions that got their thread in this run. */
  created: number;
  /** Actions still waiting: their anchor is unreadable and they have tries left. */
  deferred: number;
  failed: number;
}

export interface DeferredTopicDeps {
  db: D1Database;
  network: CardanoNetwork;
  now: number;
  /** Slug-suffix source (injected for deterministic tests). */
  rand: () => string;
  /** Anchor fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch;
  /** Max waiting actions to handle per run (bounds anchor fetches per tick). */
  limit: number;
}

/**
 * Opens the threads discovery held back because the action's anchor was unreadable
 * (see DEFERRED_TOPIC_MAX_ATTEMPTS for why waiting is worth it). Re-reads the anchor
 * for each waiting action: on success the recovered metadata is stored and the thread
 * opens under the real title. An anchor that still does not answer counts one attempt
 * and the action waits for the next run, until the budget is spent. A document that
 * arrives but is unusable ends the wait at once. Both open on the fallback title.
 *
 * Self-limiting: once every action has a thread the candidate set is empty and the
 * phase writes nothing, so it is safe to call every tick.
 */
export async function createDeferredGovTopics(deps: DeferredTopicDeps): Promise<DeferredTopicResult> {
  const { db, network, now, rand, fetchImpl, limit } = deps;
  const cfg = resolveNetwork(network);
  const candidates = await getActionsAwaitingTopic(db, limit);
  let created = 0;
  let deferred = 0;
  let failed = 0;

  for (const ga of candidates) {
    try {
      let title = ga.title;
      let abstract = ga.abstract;

      if (!title && ga.anchorUrl && ga.anchorHash && ga.metaAttempts < DEFERRED_TOPIC_MAX_ATTEMPTS) {
        const result = await rereadActionAnchor(db, ga, fetchImpl);
        if (result.status === 'ok') {
          title = result.metadata.title;
          abstract = result.metadata.abstract;
        } else if (anchorMayStillAnswer(result.status)) {
          deferred++;
          continue;
        }
      }

      // A real title, or the fallback because the budget is spent or the document
      // itself is unusable.
      await openGovActionTopic(db, {
        type: ga.type,
        title: title || fallbackActionTitle(ga.type, ga.id),
        bodyMd: composeFirstPostMd(firstPostFieldsFromAction(ga), abstract, network),
        postedAt: govPostedAtMs(ga.submittedAt, ga.submittedEpoch, cfg, now),
        now,
        rand: rand(),
        link: (topicId) => buildAttachActionTopic(db, ga.id, topicId),
      });
      created++;
    } catch {
      failed++;
    }
  }

  return { scanned: candidates.length, created, deferred, failed };
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
    try {
      // A row left for the next run (unreachable anchor, failed integrity check)
      // keeps its old version, so it stays a candidate until it exhausts its
      // attempt budget. The topic title and opening post are reconciled
      // separately by backfillGovTopicTitles, so this stays on the action row.
      if ((await rereadActionAnchor(db, ga, fetchImpl)).status === 'ok') updated++;
      else failed++;
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
    // Both have to be at the target, not just the topic. An earlier run that
    // stamped a vote-rationale cross-post instead of the opening post moved the
    // topic to the target and left the opening post behind, and a topic-only
    // guard would then read as "already correct" and never repair it.
    if (c.createdAt === submittedAtMs && c.openingPostAt === submittedAtMs) continue;
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
    const bodyMd = composeFirstPostMd(firstPostFieldsFromAction(ga), ga.abstract, network);
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
