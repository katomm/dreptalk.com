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

/** Ids of actions whose on-chain payload has not yet been stored (backfill target). */
export async function getActionIdsMissingOnchainPayload(db: D1Database): Promise<Set<string>> {
  const rows =
    (await db.prepare('SELECT id FROM governance_actions WHERE onchain_payload IS NULL').all<{ id: string }>())
      .results ?? [];
  return new Set(rows.map((r) => r.id));
}

/** Stores the raw proposal_description JSON for one action (backfill). */
export async function updateActionOnchainPayload(db: D1Database, id: string, payload: string): Promise<void> {
  await db.prepare('UPDATE governance_actions SET onchain_payload = ? WHERE id = ?').bind(payload, id).run();
}

/** Ids of actions whose exact submission time has not yet been stored (backfill target). */
export async function getActionIdsMissingSubmittedAt(db: D1Database): Promise<Set<string>> {
  const rows =
    (await db.prepare('SELECT id FROM governance_actions WHERE submitted_at IS NULL').all<{ id: string }>())
      .results ?? [];
  return new Set(rows.map((r) => r.id));
}

/** Stores the exact on-chain submission time (unix ms) for one action (backfill). */
export async function updateActionSubmittedAt(db: D1Database, id: string, submittedAt: number): Promise<void> {
  await db.prepare('UPDATE governance_actions SET submitted_at = ? WHERE id = ?').bind(submittedAt, id).run();
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
  /** Exact on-chain submission time (unix ms, from Koios block_time), or null/absent. */
  submittedAt?: number | null;
  expiryEpoch: number | null;
  /** Raw Koios proposal_description JSON, or null/absent when not available. */
  onchainPayload?: string | null;
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
          return_address, deposit, submitted_epoch, submitted_at, expiry_epoch, onchain_payload, status, meta_version, topic_id, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
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
      a.submittedAt ?? null,
      a.expiryEpoch,
      a.onchainPayload ?? null,
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
  submittedAt: number | null;
  expiryEpoch: number | null;
  status: string;
  onchainPayload: string | null;
  // Per-option vote COUNTS (number of DReps / pools / CC members voting each way).
  drepYes: number | null;
  drepNo: number | null;
  drepAbstain: number | null;
  spoYes: number | null;
  spoNo: number | null;
  spoAbstain: number | null;
  ccYes: number | null;
  ccNo: number | null;
  ccAbstain: number | null;
  // Per-option vote POWER in lovelace (DRep/SPO only; CC has no stake). The amount
  // of stake behind each option, distinct from the counts above.
  drepYesPower: number | null;
  drepNoPower: number | null;
  drepAbstainPower: number | null;
  spoYesPower: number | null;
  spoNoPower: number | null;
  spoAbstainPower: number | null;
  /** Eligible SPO voting stake (lovelace): the denominator for SPO turnout.
      Numerator is spoYesPower + spoNoPower + spoAbstainPower. */
  spoEligiblePower: number | null;
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
  submitted_at: number | null;
  expiry_epoch: number | null;
  status: string;
  onchain_payload: string | null;
  drep_yes: number | null;
  drep_no: number | null;
  drep_abstain: number | null;
  spo_yes: number | null;
  spo_no: number | null;
  spo_abstain: number | null;
  cc_yes: number | null;
  cc_no: number | null;
  cc_abstain: number | null;
  drep_yes_power: number | null;
  drep_no_power: number | null;
  drep_abstain_power: number | null;
  spo_yes_power: number | null;
  spo_no_power: number | null;
  spo_abstain_power: number | null;
  spo_eligible_power: number | null;
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
    submittedAt: r.submitted_at,
    expiryEpoch: r.expiry_epoch,
    status: r.status,
    onchainPayload: r.onchain_payload,
    drepYes: r.drep_yes,
    drepNo: r.drep_no,
    drepAbstain: r.drep_abstain,
    spoYes: r.spo_yes,
    spoNo: r.spo_no,
    spoAbstain: r.spo_abstain,
    ccYes: r.cc_yes,
    ccNo: r.cc_no,
    ccAbstain: r.cc_abstain,
    drepYesPower: r.drep_yes_power,
    drepNoPower: r.drep_no_power,
    drepAbstainPower: r.drep_abstain_power,
    spoYesPower: r.spo_yes_power,
    spoNoPower: r.spo_no_power,
    spoAbstainPower: r.spo_abstain_power,
    spoEligiblePower: r.spo_eligible_power,
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
 * Ratified-but-not-yet-enacted actions, for the lightweight lifecycle re-check.
 * Koios sets enacted_epoch ~1 epoch after ratified_epoch, so 'ratified' is a
 * transient resting state, not a frozen one: getStaleSyncableActions excludes it
 * (its tally is final), but the re-check keeps reading these from the shared
 * proposal_list until they flip to a truly terminal status (usually 'enacted'),
 * so a row first synced inside that gap is not stuck on 'ratified' forever.
 * Least-recently-synced first, bounded by `limit`, mirroring the tally sync.
 */
export async function getRatifiedActions(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        `SELECT * FROM governance_actions
         WHERE status = 'ratified'
         ORDER BY last_synced_at ASC, expiry_epoch ASC
         LIMIT ?`,
      )
      .bind(limit)
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/**
 * Like getStaleSyncableActions, but ordered for the vote-list sync: never-vote-
 * synced rows first (votes_synced_at NULL), then the least-recently vote-synced.
 * The vote sync has its own timestamp because it runs on a different cadence than
 * the tally sync; ordering by tally recency would let active actions whose tally
 * is fresh but whose vote list is hours stale starve when the active set exceeds
 * the per-run limit.
 */
export async function getVoteStaleSyncableActions(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        // `votes_synced_at IS NOT NULL` sorts NULL (never-synced) first; then
        // oldest vote sync first; expiry breaks ties deterministically.
        `SELECT * FROM governance_actions
         WHERE status IN ('active', 'pending')
         ORDER BY votes_synced_at IS NOT NULL, votes_synced_at ASC, expiry_epoch ASC
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
 * slug; ordered by exact on-chain submission time (newest first), then submission
 * epoch and discovery time as fallbacks while submitted_at is still null. Null
 * when none exist yet (fresh deploy / local dev without sync).
 */
export async function getLatestGovernanceAction(db: D1Database): Promise<LatestGovernanceAction | null> {
  const row = await db
    .prepare(
      `SELECT ga.*, t.slug AS slug
         FROM governance_actions ga
         JOIN topics t ON t.id = ga.topic_id
        WHERE t.deleted = 0 AND ga.title IS NOT NULL
        ORDER BY ga.submitted_at IS NULL, ga.submitted_at DESC, ga.submitted_epoch DESC, ga.created_at DESC
        LIMIT 1`,
    )
    .first<GovernanceActionRow & { slug: string }>();
  return row ? { action: rowToGovernanceAction(row), slug: row.slug } : null;
}

/**
 * The newest governance action that already has at least `minVoters` recorded
 * DRep votes, for the homepage hero's ring of real voter pills. Same visibility
 * filter and ordering as getLatestGovernanceAction, plus a correlated count that
 * skips fresh actions whose pill ring would be empty (the card and its six pills
 * describe the same action, so a half-empty ring is never shown). Returns null
 * when none qualifies, leaving the caller on the decorative fallback hero.
 */
export async function getLatestActionWithVotes(
  db: D1Database,
  opts: { minVoters: number },
): Promise<LatestGovernanceAction | null> {
  const min = Math.max(opts.minVoters, 1);
  const row = await db
    .prepare(
      `SELECT ga.*, t.slug AS slug
         FROM governance_actions ga
         JOIN topics t ON t.id = ga.topic_id
        WHERE t.deleted = 0 AND ga.title IS NOT NULL
          AND (
            SELECT COUNT(*) FROM drep_votes v
             WHERE v.ga_id = ga.id AND v.voter_role = 'DRep'
          ) >= ?
        ORDER BY ga.submitted_at IS NULL, ga.submitted_at DESC, ga.submitted_epoch DESC, ga.created_at DESC
        LIMIT 1`,
    )
    .bind(min)
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
      // Exact on-chain submission time first (newest), so same-epoch actions order
      // by when they were actually submitted, not by a random topic id. submitted_at
      // IS NULL puts not-yet-backfilled rows last, where they fall back to epoch order.
      return 'ga.submitted_at IS NULL, ga.submitted_at DESC, ga.submitted_epoch DESC, ga.topic_id ASC';
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
  opts: { categorySlug: string; sort: GovSort; limit: number; offset: number; type?: string | null },
): Promise<{ topicIds: string[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const offset = Math.max(opts.offset, 0);

  // Closing-Soon is the only mode that filters by status. The terminal set is bound
  // (never interpolated) and shared with isTerminalStatus via TERMINAL_STATUSES, so the
  // SQL and in-memory definitions of "terminal" cannot drift.
  const terminalBinds = opts.sort === 'closing' ? [...TERMINAL_STATUSES] : [];
  const terminalFilter =
    opts.sort === 'closing' ? ` AND ga.status NOT IN (${sqlPlaceholders(terminalBinds)})` : '';
  // Optional single-type filter. The value is a bound parameter (never interpolated),
  // so it stays injection-safe; an absent/null type leaves the query unchanged.
  const typeBinds = opts.type ? [opts.type] : [];
  const typeFilter = opts.type ? ' AND ga.type = ?' : '';
  const base =
    'FROM governance_actions ga JOIN topics t ON t.id = ga.topic_id ' +
    `WHERE t.category_slug = ? AND t.deleted = 0${terminalFilter}${typeFilter}`;

  const [idResult, countRow] = await Promise.all([
    db
      .prepare(`SELECT ga.topic_id AS topic_id ${base} ORDER BY ${govPageOrderBy(opts.sort)} LIMIT ? OFFSET ?`)
      .bind(opts.categorySlug, ...terminalBinds, ...typeBinds, limit, offset)
      .all<{ topic_id: string }>(),
    db
      .prepare(`SELECT COUNT(*) AS n ${base}`)
      .bind(opts.categorySlug, ...terminalBinds, ...typeBinds)
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
 * Terminal actions still missing power data: the turnout sum (drep_voted_power),
 * the per-option power buckets (drep_yes_power), or the eligible SPO stake
 * (spo_eligible_power). Active/pending actions get these from the normal tally, so
 * they are excluded here. Re-fetching the summary also corrects any older SPO power
 * that predates the active/passive split. Bounded by `limit` so a cron tick stays
 * within Koios/subrequest budgets.
 */
export async function getActionsNeedingVotedPower(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        `SELECT * FROM governance_actions
         WHERE proposal_id IS NOT NULL
           AND (drep_voted_power IS NULL OR drep_yes_power IS NULL OR spo_eligible_power IS NULL)
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

/**
 * Governance actions whose stored title differs from their topic's title: the topic
 * kept a discovery-time fallback while the action later got the real anchor title
 * (the anchor failed at discovery and was re-fetched, or an older backfill updated
 * only the action row). The topic-title reconciliation sweep reads these and syncs
 * the topic + opening post. Excludes rows with a null action title (only a fallback
 * exists, nothing to sync) and deleted topics. `t.title IS NOT ga.title` is the
 * null-safe inequality (action title is already non-null here).
 */
export async function getGovActionsWithStaleTopicTitle(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        `SELECT ga.* FROM governance_actions ga
         JOIN topics t ON t.id = ga.topic_id
         WHERE t.source = 'governance' AND t.deleted = 0 AND ga.title IS NOT NULL AND t.title IS NOT ga.title
         LIMIT ?`,
      )
      .bind(limit)
      .all<GovernanceActionRow>()
  ).results ?? [];
  return rows.map(rowToGovernanceAction);
}

/** The power fields the backfill sets: turnout sum plus per-option DRep/SPO buckets.
    All optional; an omitted field writes null. */
export interface VotePowerFields {
  votedPower?: number | null;
  drepYesPower?: number | null;
  drepNoPower?: number | null;
  drepAbstainPower?: number | null;
  spoYesPower?: number | null;
  spoNoPower?: number | null;
  spoAbstainPower?: number | null;
  spoEligiblePower?: number | null;
}

/** Surgically sets the power columns for one action (leaves status/tally/pct untouched). */
export async function updateVotedPower(db: D1Database, id: string, p: VotePowerFields): Promise<void> {
  await db
    .prepare(
      `UPDATE governance_actions
         SET drep_voted_power = ?,
             drep_yes_power = ?, drep_no_power = ?, drep_abstain_power = ?,
             spo_yes_power = ?, spo_no_power = ?, spo_abstain_power = ?, spo_eligible_power = ?
       WHERE id = ?`,
    )
    .bind(
      p.votedPower ?? null,
      p.drepYesPower ?? null,
      p.drepNoPower ?? null,
      p.drepAbstainPower ?? null,
      p.spoYesPower ?? null,
      p.spoNoPower ?? null,
      p.spoAbstainPower ?? null,
      p.spoEligiblePower ?? null,
      id,
    )
    .run();
}

/**
 * Actions the metadata backfill should (re-)read an anchor for: either their
 * stored metadata predates the current extractor (meta_version < current), OR
 * their last anchor fetch did not succeed (anchor_status != 'ok'). The second
 * arm is what self-heals an anchor that was momentarily unreachable at discovery:
 * such a row is stamped at the current version with empty metadata, so the
 * version check alone would never revisit it. Rows that have failed
 * re-extraction maxAttempts times are excluded: their anchor is treated as
 * permanently dead so the backfill stops retrying it every run.
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
         WHERE anchor_url IS NOT NULL AND (meta_version < ? OR anchor_status != 'ok') AND meta_attempts < ?
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
       WHERE anchor_url IS NOT NULL AND (meta_version < ? OR anchor_status != 'ok') AND meta_attempts >= ?`,
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

/**
 * Finalized actions that still have at least one anchored vote without a stored
 * meta_hash. These are votes synced before meta_hash capture existed, so the
 * rationale queue (which requires both meta_url and meta_hash) skips them. The
 * meta_hash backfill re-fetches each action's votes to fill the hash. Self-
 * draining: an action drops out once none of its anchored votes lack a hash.
 */
export async function getActionsNeedingMetaHashBackfill(db: D1Database, limit: number): Promise<GovernanceAction[]> {
  const rows = (
    await db
      .prepare(
        `SELECT * FROM governance_actions g
         WHERE g.status NOT IN ('active', 'pending')
           AND g.proposal_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM drep_votes v
             WHERE v.ga_id = g.id
               AND v.meta_url IS NOT NULL AND v.meta_url != ''
               AND (v.meta_hash IS NULL OR v.meta_hash = '')
           )
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

/** A gov_status feed event whose time can be re-derived from its action's epoch. */
export interface GovStatusEventTime {
  id: string;
  decidedEpoch: number;
  createdAt: number;
}

/**
 * gov_status feed events whose stored time should be re-derived from the on-chain
 * epoch boundary: the event marks the action's CURRENT terminal status, so the
 * action's single decided_epoch IS this transition's epoch. Older transitions of
 * the same action (e.g. a prior 'ratified' before it enacted) are excluded, since
 * their epoch is not recoverable from decided_epoch; they keep their detection
 * time. Drives backfillGovStatusTimes. Bounded by `limit`.
 */
export async function getGovStatusEventsForTimeFix(db: D1Database, limit: number): Promise<GovStatusEventTime[]> {
  const rows = (
    await db
      .prepare(
        `SELECT a.id AS id, ga.decided_epoch AS decidedEpoch, a.created_at AS createdAt
           FROM activity a
           JOIN governance_actions ga ON ga.topic_id = a.topic_id
          WHERE a.type = 'gov_status'
            AND ga.decided_epoch IS NOT NULL
            AND json_extract(a.payload, '$.to') = ga.status
          LIMIT ?`,
      )
      .bind(limit)
      .all<GovStatusEventTime>()
  ).results ?? [];
  return rows;
}

/** Sets one activity event's created_at (used by the gov_status time backfill). */
export async function updateActivityCreatedAt(db: D1Database, id: string, createdAt: number): Promise<void> {
  await db.prepare('UPDATE activity SET created_at = ? WHERE id = ?').bind(createdAt, id).run();
}

/** A governance action by the same proposer, with the topic slug for linking. */
export interface RelatedActionRow {
  id: string;
  title: string | null;
  type: string;
  status: string;
  topic_slug: string;
}

/**
 * Other governance actions from the same proposer (return_address) for the
 * detail-page sidebar, most recent first, excluding the current action. Only
 * actions that have a forum topic (so they are linkable). Returns [] when the
 * action has no proposer, since a null return_address relates to nothing.
 *
 * Type is deliberately not a relatedness signal: with only seven action types,
 * two actions sharing a type (say, two unrelated treasury withdrawals) say
 * nothing about being about the same thing. Proposer is the meaningful link.
 */
export async function getRelatedActions(
  db: D1Database,
  opts: { excludeId: string; returnAddress: string | null; limit?: number },
): Promise<RelatedActionRow[]> {
  if (opts.returnAddress === null) return [];
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20);
  return (
    await db
      .prepare(
        `SELECT g.id AS id, g.title AS title, g.type AS type, g.status AS status, t.slug AS topic_slug
         FROM governance_actions g
         JOIN topics t ON t.id = g.topic_id
         WHERE g.return_address = ? AND g.id != ?
         ORDER BY g.submitted_epoch DESC
         LIMIT ?`,
      )
      .bind(opts.returnAddress, opts.excludeId, limit)
      .all<RelatedActionRow>()
  ).results ?? [];
}

/** Updates an action's extracted metadata fields and bumps its meta_version. */
export async function updateActionMetadata(
  db: D1Database,
  id: string,
  m: { title: string | null; abstract: string | null; rationaleHtml: string | null; metaVersion: number },
): Promise<void> {
  // Only ever called after a successful, hash-verified extraction, so the row
  // settles as anchor_status 'ok'. This is essential for rows recovered from a
  // failed fetch: without it they keep anchor_status != 'ok' and the retry
  // predicate would re-fetch them on every run forever. A successful extract also
  // clears meta_attempts so a future version bump starts this row's retry budget
  // fresh (a past dead spell must not count against it).
  await db
    .prepare(
      "UPDATE governance_actions SET title = ?, abstract = ?, rationale_html = ?, anchor_status = 'ok', meta_version = ?, meta_attempts = 0 WHERE id = ?",
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
> &
  // Per-option power is optional on the update so older callers/tests need not
  // supply it; tallyFields always does. Omitted means the column is left null.
  Partial<
    Pick<
      GovernanceAction,
      | 'drepYesPower' | 'drepNoPower' | 'drepAbstainPower'
      | 'spoYesPower' | 'spoNoPower' | 'spoAbstainPower' | 'spoEligiblePower'
    >
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
 * Advances only the lifecycle status (and the decided epoch) of an action,
 * leaving the frozen tally and the votes_synced_at marker untouched. Used by the
 * ratified -> enacted re-check, which derives the new status from the shared
 * proposal_list: the tally and per-voter votes were already finalised when the
 * action first froze, so re-pulling or wiping them here would be wasteful.
 */
export async function updateGovernanceActionStatus(
  db: D1Database,
  u: { id: string; status: string; decidedEpoch: number | null; now: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE governance_actions
         SET status = ?, decided_epoch = ?, last_synced_at = ?
       WHERE id = ?`,
    )
    .bind(u.status, u.decidedEpoch, u.now, u.id)
    .run();
}

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
             drep_yes_power = ?, drep_no_power = ?, drep_abstain_power = ?,
             spo_yes_power = ?, spo_no_power = ?, spo_abstain_power = ?, spo_eligible_power = ?,
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
      u.drepYesPower ?? null,
      u.drepNoPower ?? null,
      u.drepAbstainPower ?? null,
      u.spoYesPower ?? null,
      u.spoNoPower ?? null,
      u.spoAbstainPower ?? null,
      u.spoEligiblePower ?? null,
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
