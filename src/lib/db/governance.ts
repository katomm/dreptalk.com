/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the governance_actions table.
// All queries use .prepare().bind(); never string-concatenated SQL.

import { sqlPlaceholders } from './sql.js';
import { TERMINAL_STATUSES } from '../governance/view.js';
import type { GovSort } from '../governance/sort.js';

/** Returns the set of governance-action ids already stored, for the sync diff. */
export async function getKnownActionIds(db: D1Database): Promise<Set<string>> {
  const rows = (await db.prepare('SELECT id FROM governance_actions').all<{ id: string }>()).results ?? [];
  return new Set(rows.map((r) => r.id));
}

export interface NewGovernanceAction {
  id: string;
  proposalId: string | null;
  type: string;
  title: string | null;
  abstract: string | null;
  rationaleHtml: string | null;
  anchorUrl: string | null;
  anchorHash: string | null;
  anchorStatus: string;
  returnAddress: string | null;
  deposit: string | null;
  submittedEpoch: number | null;
  expiryEpoch: number | null;
  /** Metadata-extraction version used when writing title/abstract/rationale_html. */
  metaVersion: number;
  topicId: string;
  now: number;
}

/**
 * Builds the (idempotent) governance-action INSERT as a prepared statement so it
 * can be committed in the same atomic db.batch() as the topic and first post.
 */
export function buildInsertGovernanceAction(db: D1Database, a: NewGovernanceAction): D1PreparedStatement {
  return db
    .prepare(
      // status starts 'pending' (discovered, not yet verified). The tally/lifecycle
      // sync sets the real status (active / enacted / expired / dropped). Showing a
      // freshly discovered action as 'active' before we have checked would mislead.
      `INSERT OR IGNORE INTO governance_actions
         (id, proposal_id, type, title, abstract, rationale_html, anchor_url, anchor_hash, anchor_status,
          return_address, deposit, submitted_epoch, expiry_epoch, status, meta_version, topic_id, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .bind(
      a.id,
      a.proposalId,
      a.type,
      a.title,
      a.abstract,
      a.rationaleHtml,
      a.anchorUrl,
      a.anchorHash,
      a.anchorStatus,
      a.returnAddress,
      a.deposit,
      a.submittedEpoch,
      a.expiryEpoch,
      a.metaVersion,
      a.topicId,
      a.now,
      a.now,
    );
}

// Tally percentages are power-weighted for DRep/SPO and count-weighted for CC
// (as Koios computes them). Counts are the votes_cast numbers. All nullable
// until the tally sync first populates them.
export interface GovernanceAction {
  id: string;
  proposalId: string | null;
  type: string;
  title: string | null;
  abstract: string | null;
  rationaleHtml: string | null;
  anchorUrl: string | null;
  anchorHash: string | null;
  anchorStatus: string;
  returnAddress: string | null;
  deposit: string | null;
  submittedEpoch: number | null;
  expiryEpoch: number | null;
  status: string;
  drepYes: number | null;
  drepNo: number | null;
  drepAbstain: number | null;
  spoYes: number | null;
  spoNo: number | null;
  spoAbstain: number | null;
  ccYes: number | null;
  ccNo: number | null;
  ccAbstain: number | null;
  drepYesPct: number | null;
  drepNoPct: number | null;
  spoYesPct: number | null;
  spoNoPct: number | null;
  ccYesPct: number | null;
  ccNoPct: number | null;
  drepVotedPower: number | null;
  tallyEpoch: number | null;
  tallySyncedAt: number | null;
  decidedEpoch: number | null;
  /** Metadata-extraction version stored with this row's title/abstract/rationale_html. */
  metaVersion: number;
  topicId: string | null;
  createdAt: number;
  lastSyncedAt: number;
  /** Materialized trending sort key (gov-sync cron); null until first refreshed. */
  trendingScore: number | null;
}

interface GovernanceActionRow {
  id: string;
  proposal_id: string | null;
  type: string;
  title: string | null;
  abstract: string | null;
  rationale_html: string | null;
  anchor_url: string | null;
  anchor_hash: string | null;
  anchor_status: string;
  return_address: string | null;
  deposit: string | null;
  submitted_epoch: number | null;
  expiry_epoch: number | null;
  status: string;
  drep_yes: number | null;
  drep_no: number | null;
  drep_abstain: number | null;
  spo_yes: number | null;
  spo_no: number | null;
  spo_abstain: number | null;
  cc_yes: number | null;
  cc_no: number | null;
  cc_abstain: number | null;
  drep_yes_pct: number | null;
  drep_no_pct: number | null;
  spo_yes_pct: number | null;
  spo_no_pct: number | null;
  cc_yes_pct: number | null;
  cc_no_pct: number | null;
  drep_voted_power: number | null;
  tally_epoch: number | null;
  tally_synced_at: number | null;
  decided_epoch: number | null;
  meta_version: number;
  topic_id: string | null;
  created_at: number;
  last_synced_at: number;
  trending_score: number | null;
}

function rowToGovernanceAction(r: GovernanceActionRow): GovernanceAction {
  return {
    id: r.id,
    proposalId: r.proposal_id,
    type: r.type,
    title: r.title,
    abstract: r.abstract,
    rationaleHtml: r.rationale_html,
    anchorUrl: r.anchor_url,
    anchorHash: r.anchor_hash,
    anchorStatus: r.anchor_status,
    returnAddress: r.return_address,
    deposit: r.deposit,
    submittedEpoch: r.submitted_epoch,
    expiryEpoch: r.expiry_epoch,
    status: r.status,
    drepYes: r.drep_yes,
    drepNo: r.drep_no,
    drepAbstain: r.drep_abstain,
    spoYes: r.spo_yes,
    spoNo: r.spo_no,
    spoAbstain: r.spo_abstain,
    ccYes: r.cc_yes,
    ccNo: r.cc_no,
    ccAbstain: r.cc_abstain,
    drepYesPct: r.drep_yes_pct,
    drepNoPct: r.drep_no_pct,
    spoYesPct: r.spo_yes_pct,
    spoNoPct: r.spo_no_pct,
    ccYesPct: r.cc_yes_pct,
    ccNoPct: r.cc_no_pct,
    drepVotedPower: r.drep_voted_power,
    tallyEpoch: r.tally_epoch,
    tallySyncedAt: r.tally_synced_at,
    decidedEpoch: r.decided_epoch,
    metaVersion: r.meta_version,
    topicId: r.topic_id,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
    trendingScore: r.trending_score,
  };
}

/** Returns the governance action attached to a topic, or null. Drives the GA thread header. */
export async function getGovernanceActionByTopicId(
  db: D1Database,
  topicId: string,
): Promise<GovernanceAction | null> {
  const row = await db
    .prepare('SELECT * FROM governance_actions WHERE topic_id = ?')
    .bind(topicId)
    .first<GovernanceActionRow>();
  return row ? rowToGovernanceAction(row) : null;
}

/**
 * Returns syncable actions (status 'active' or 'pending'; terminal actions are
 * frozen and excluded) ordered for incremental, budget-bounded syncing:
 * never-synced rows first (tally_synced_at NULL), then the least-recently-synced,
 * capped by `limit`. Both the tally and vote syncs use this so a run always makes
 * forward progress on the backlog. Koios is latency-limited under a large burst
 * (proposal_voting_summary 504s/times-out), so a run must stay small and
 * prioritise what has never been synced; otherwise the same front rows are
 * re-synced every run and never-synced ones at the tail starve.
 */
export async function getStaleSyncableActions(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        // `tally_synced_at IS NOT NULL` sorts NULL (never-synced) first; then
        // oldest tally first; expiry breaks ties deterministically.
        `SELECT * FROM governance_actions
         WHERE status IN ('active', 'pending')
         ORDER BY tally_synced_at IS NOT NULL, tally_synced_at ASC, expiry_epoch ASC
         LIMIT ?`,
      )
      .bind(limit)
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/**
 * Returns every governance action. The table holds one row per on-chain action
 * (low hundreds), so this is a single param-less query, used by the sorted
 * governance-actions list (which would otherwise exceed D1's bound-parameter cap
 * with a large IN clause).
 */
export async function getAllGovernanceActions(db: D1Database): Promise<GovernanceAction[]> {
  const rows = (
    await db.prepare('SELECT * FROM governance_actions').all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/** The newest governance action plus its thread slug, for the homepage hero preview. */
export interface LatestGovernanceAction {
  action: GovernanceAction;
  slug: string;
}

/**
 * Returns the single newest titled governance action with a live topic, for the
 * homepage hero card. One indexed LIMIT 1 query joined to topics for the thread
 * slug; ordered by submission epoch (newest first), then discovery time as a
 * tiebreak. Null when none exist yet (fresh deploy / local dev without sync).
 */
export async function getLatestGovernanceAction(db: D1Database): Promise<LatestGovernanceAction | null> {
  const row = await db
    .prepare(
      `SELECT ga.*, t.slug AS slug
         FROM governance_actions ga
         JOIN topics t ON t.id = ga.topic_id
        WHERE t.deleted = 0 AND ga.title IS NOT NULL
        ORDER BY ga.submitted_epoch DESC, ga.created_at DESC
        LIMIT 1`,
    )
    .first<GovernanceActionRow & { slug: string }>();
  return row ? { action: rowToGovernanceAction(row), slug: row.slug } : null;
}

/** Batch-loads governance actions by topic id (no N+1 when rendering a list). */
export async function getGovernanceActionsByTopicIds(
  db: D1Database,
  topicIds: string[],
): Promise<Map<string, GovernanceAction>> {
  if (topicIds.length === 0) return new Map();

  const placeholders = sqlPlaceholders(topicIds);
  const rows = (
    await db
      .prepare(`SELECT * FROM governance_actions WHERE topic_id IN (${placeholders})`)
      .bind(...topicIds)
      .all<GovernanceActionRow>()
  ).results ?? [];

  const map = new Map<string, GovernanceAction>();
  for (const row of rows) {
    if (row.topic_id) map.set(row.topic_id, rowToGovernanceAction(row));
  }
  return map;
}

// ORDER BY fragment per sort mode. These are constant strings chosen by a fixed switch
// over the GovSort union (never user input), so interpolating them keeps the query
// injection-safe while all actual values stay bound parameters. Every mode ends with
// topic_id so equal-key ties are deterministic.
function govPageOrderBy(sort: GovSort): string {
  switch (sort) {
    case 'new':
      return 'ga.submitted_epoch DESC, ga.topic_id ASC';
    case 'closing':
      // expiry_epoch IS NULL sorts undated-but-open actions last (after the dated ones).
      return 'ga.expiry_epoch IS NULL, ga.expiry_epoch ASC, ga.topic_id ASC';
    case 'ratified':
      return 'ga.decided_epoch DESC, ga.topic_id ASC';
    default:
      // trending (default): the cron-materialized score drives it; submitted_epoch then
      // topic_id break ties, reproducing the in-memory sortGovActionTopics order exactly.
      // NULL scores (not yet refreshed) sort last under DESC.
      return 'ga.trending_score DESC, ga.submitted_epoch DESC, ga.topic_id ASC';
  }
}

/**
 * One page of governance-action topic ids for the list view, ordered and sliced in the
 * database so the hot path is O(page size), not O(all actions). Inner-joins topics to
 * actions (an action with no live, non-deleted topic in this category is never listed,
 * matching the old in-memory filter), orders per the sort mode (trending reads the
 * cron-materialized trending_score; the others read raw lifecycle-epoch columns), and
 * returns the page's topic ids plus the full matching count for pagination. Closing-Soon
 * drops terminal actions from both the page and the count.
 *
 * The caller hydrates the ids with getTopicsByIds + getGovernanceActionsByTopicIds (two
 * batched IN queries, no N+1). limit is clamped to [1,100]; offset to >= 0.
 */
export async function getGovernanceActionTopicIdsPage(
  db: D1Database,
  opts: { categorySlug: string; sort: GovSort; limit: number; offset: number },
): Promise<{ topicIds: string[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const offset = Math.max(opts.offset, 0);

  // Closing-Soon is the only mode that filters by status. The terminal set is bound
  // (never interpolated) and shared with isTerminalStatus via TERMINAL_STATUSES, so the
  // SQL and in-memory definitions of "terminal" cannot drift.
  const terminalBinds = opts.sort === 'closing' ? [...TERMINAL_STATUSES] : [];
  const terminalFilter =
    opts.sort === 'closing' ? ` AND ga.status NOT IN (${sqlPlaceholders(terminalBinds)})` : '';
  const base =
    'FROM governance_actions ga JOIN topics t ON t.id = ga.topic_id ' +
    `WHERE t.category_slug = ? AND t.deleted = 0${terminalFilter}`;

  const [idResult, countRow] = await Promise.all([
    db
      .prepare(`SELECT ga.topic_id AS topic_id ${base} ORDER BY ${govPageOrderBy(opts.sort)} LIMIT ? OFFSET ?`)
      .bind(opts.categorySlug, ...terminalBinds, limit, offset)
      .all<{ topic_id: string }>(),
    db
      .prepare(`SELECT COUNT(*) AS n ${base}`)
      .bind(opts.categorySlug, ...terminalBinds)
      .first<{ n: number }>(),
  ]);

  return { topicIds: (idResult.results ?? []).map((r) => r.topic_id), total: countRow?.n ?? 0 };
}

/**
 * Writes precomputed trending scores in one atomic batch (no-op when empty). Driven by
 * the gov-sync cron's only-changed refresh, so the usual batch is small; the first run
 * after a deploy writes the whole (low-hundreds) backlog in a single batch.
 */
export async function batchUpdateTrendingScores(
  db: D1Database,
  updates: readonly { id: string; score: number }[],
): Promise<void> {
  if (updates.length === 0) return;
  await db.batch(
    updates.map((u) =>
      db.prepare('UPDATE governance_actions SET trending_score = ? WHERE id = ?').bind(u.score, u.id),
    ),
  );
}

/**
 * Terminal actions still missing their voted-power backfill. Active/pending
 * actions get drep_voted_power from the normal tally, so they are excluded here.
 * Bounded by `limit` so a cron tick stays within Koios/subrequest budgets.
 */
export async function getActionsNeedingVotedPower(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        `SELECT * FROM governance_actions
         WHERE proposal_id IS NOT NULL AND drep_voted_power IS NULL
           AND status NOT IN ('active', 'pending')
         LIMIT ?`,
      )
      .bind(limit)
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/** A no-reply governance topic plus the epoch needed to derive its submission time. */
export interface GovTopicSubmittedAt {
  topicId: string;
  submittedEpoch: number;
  createdAt: number;
  lastPostAt: number;
}

/**
 * Governance topics with no real replies (post_count <= 1) and a known submission
 * epoch, for the post-date backfill. Sweeps our own tables (not the live Koios list),
 * so the whole backlog is covered, including terminal actions Koios may no longer
 * return. Bounded by `limit`.
 */
export async function getGovTopicsForSubmittedAtBackfill(
  db: D1Database,
  limit: number,
): Promise<GovTopicSubmittedAt[]> {
  const rows = (
    await db
      .prepare(
        `SELECT t.id AS topicId, ga.submitted_epoch AS submittedEpoch,
                t.created_at AS createdAt, t.last_post_at AS lastPostAt
         FROM topics t
         JOIN governance_actions ga ON ga.topic_id = t.id
         WHERE t.source = 'governance' AND t.post_count <= 1 AND ga.submitted_epoch IS NOT NULL
         LIMIT ?`,
      )
      .bind(limit)
      .all<GovTopicSubmittedAt>()
  ).results ?? [];
  return rows;
}

/** Surgically sets only drep_voted_power for one action (leaves status/tally untouched). */
export async function updateVotedPower(db: D1Database, id: string, votedPower: number): Promise<void> {
  await db.prepare('UPDATE governance_actions SET drep_voted_power = ? WHERE id = ?').bind(votedPower, id).run();
}

/**
 * Actions whose stored metadata predates the current extractor and have an
 * anchor to re-read. Rows that have failed re-extraction maxAttempts times are
 * excluded: their anchor is treated as permanently dead so the backfill stops
 * retrying it every run.
 */
export async function getActionsNeedingMetaReextract(
  db: D1Database,
  currentVersion: number,
  limit: number,
  maxAttempts: number,
): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        `SELECT * FROM governance_actions
         WHERE anchor_url IS NOT NULL AND meta_version < ? AND meta_attempts < ?
         LIMIT ?`,
      )
      .bind(currentVersion, maxAttempts, limit)
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/** Records one failed metadata re-extraction attempt; drives the give-up cap. */
export async function incrementActionMetaAttempts(db: D1Database, id: string): Promise<void> {
  await db
    .prepare('UPDATE governance_actions SET meta_attempts = meta_attempts + 1 WHERE id = ?')
    .bind(id)
    .run();
}

/**
 * Count of actions the metadata backfill has permanently given up on: stale
 * metadata with an anchor, but maxAttempts failed re-extractions. These drop out
 * of getActionsNeedingMetaReextract and would otherwise be invisible, so the
 * status page surfaces the count.
 */
export async function countGivenUpMetaActions(
  db: D1Database,
  currentVersion: number,
  maxAttempts: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM governance_actions
       WHERE anchor_url IS NOT NULL AND meta_version < ? AND meta_attempts >= ?`,
    )
    .bind(currentVersion, maxAttempts)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Finalised actions whose full per-voter vote list has never been synced
 * (votes_synced_at IS NULL) and that have a proposal id to query. Active/pending
 * actions are covered by the live vote sync, so they are excluded here. Bounded
 * by `limit` so a cron tick stays within Koios/subrequest budgets.
 */
export async function getActionsNeedingVoteBackfill(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        `SELECT * FROM governance_actions
         WHERE status NOT IN ('active', 'pending')
           AND proposal_id IS NOT NULL AND votes_synced_at IS NULL
         LIMIT ?`,
      )
      .bind(limit)
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/** Marks an action's per-voter vote list as fully synced as of `now` (ms). */
export async function markVotesSynced(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare('UPDATE governance_actions SET votes_synced_at = ? WHERE id = ?').bind(now, id).run();
}

/** A related governance action, with the topic slug for linking. */
export interface RelatedActionRow {
  id: string;
  title: string | null;
  type: string;
  status: string;
  topic_slug: string;
}

/**
 * Related governance actions for the detail-page sidebar: same type or same
 * proposer (return_address), excluding the current action, same-type first then
 * most recent. Only actions that have a forum topic (so they are linkable).
 */
export async function getRelatedActions(
  db: D1Database,
  opts: { excludeId: string; type: string; returnAddress: string | null; limit?: number },
): Promise<RelatedActionRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20);
  const rows = (
    await db
      .prepare(
        `SELECT g.id AS id, g.title AS title, g.type AS type, g.status AS status, t.slug AS topic_slug
         FROM governance_actions g
         JOIN topics t ON t.id = g.topic_id
         WHERE g.id != ? AND (g.type = ? OR (? IS NOT NULL AND g.return_address = ?))
         ORDER BY (g.type = ?) DESC, g.submitted_epoch DESC
         LIMIT ?`,
      )
      .bind(opts.excludeId, opts.type, opts.returnAddress, opts.returnAddress, opts.type, limit)
      .all<RelatedActionRow>()
  ).results ?? [];
  return rows;
}

/** Updates an action's extracted metadata fields and bumps its meta_version. */
export async function updateActionMetadata(
  db: D1Database,
  id: string,
  m: { title: string | null; abstract: string | null; rationaleHtml: string | null; metaVersion: number },
): Promise<void> {
  // A successful extract clears meta_attempts so a future version bump starts
  // this row's retry budget fresh (a past dead spell must not count against it).
  await db
    .prepare(
      'UPDATE governance_actions SET title = ?, abstract = ?, rationale_html = ?, meta_version = ?, meta_attempts = 0 WHERE id = ?',
    )
    .bind(m.title, m.abstract, m.rationaleHtml, m.metaVersion, id)
    .run();
}

// The tally + pct + epoch fields a sync writes: a subset of GovernanceAction, so
// the field list lives in exactly one place (no drift with tallyFields()).
export type GovernanceTally = Pick<
  GovernanceAction,
  | 'drepYes' | 'drepNo' | 'drepAbstain'
  | 'spoYes' | 'spoNo' | 'spoAbstain'
  | 'ccYes' | 'ccNo' | 'ccAbstain'
  | 'drepYesPct' | 'drepNoPct' | 'spoYesPct' | 'spoNoPct' | 'ccYesPct' | 'ccNoPct'
  | 'drepVotedPower'
  | 'tallyEpoch'
>;

export type GovernanceTallyUpdate = GovernanceTally & {
  id: string;
  status: string;
  // Epoch the action was decided (terminal), or null while active/pending.
  decidedEpoch: number | null;
  tallySyncedAt: number;
  now: number;
};

/**
 * Updates the tally columns, pct columns, status, and sync timestamps in place.
 * Freezing (any non-active status) also nulls votes_synced_at, which re-queues
 * the action for one final per-voter vote pull (backfillFinalizedVotes); votes
 * cast between the last hourly vote sync and the freeze would be lost otherwise.
 */
export async function updateGovernanceTallyAndStatus(
  db: D1Database,
  u: GovernanceTallyUpdate,
): Promise<void> {
  await db
    .prepare(
      `UPDATE governance_actions
         SET status = ?, drep_yes = ?, drep_no = ?, drep_abstain = ?,
             spo_yes = ?, spo_no = ?, spo_abstain = ?,
             cc_yes = ?, cc_no = ?, cc_abstain = ?,
             drep_yes_pct = ?, drep_no_pct = ?, spo_yes_pct = ?, spo_no_pct = ?,
             cc_yes_pct = ?, cc_no_pct = ?,
             drep_voted_power = ?,
             tally_epoch = ?, decided_epoch = ?, tally_synced_at = ?, last_synced_at = ?,
             votes_synced_at = CASE WHEN ? = 'active' THEN votes_synced_at ELSE NULL END
       WHERE id = ?`,
    )
    .bind(
      u.status,
      u.drepYes,
      u.drepNo,
      u.drepAbstain,
      u.spoYes,
      u.spoNo,
      u.spoAbstain,
      u.ccYes,
      u.ccNo,
      u.ccAbstain,
      u.drepYesPct,
      u.drepNoPct,
      u.spoYesPct,
      u.spoNoPct,
      u.ccYesPct,
      u.ccNoPct,
      u.drepVotedPower,
      u.tallyEpoch,
      u.decidedEpoch,
      u.tallySyncedAt,
      u.now,
      u.status,
      u.id,
    )
    .run();
}
