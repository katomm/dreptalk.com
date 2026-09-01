/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the survey tables (survey, survey_gov_link,
// survey_sync_state). All queries use .prepare().bind(); never
// string-concatenated SQL. Rows are Tessera's answers written down; the sync
// (src/lib/surveys/sync.ts) is the only writer.

import { chunked, D1_MAX_BINDS, sqlPlaceholders } from './sql.js';

/** The columns the sync's refresh/audit triggers read back per held survey. */
export interface HeldSurvey {
  ref: string;
  endEpoch: number;
  tipEpoch: number;
  claimedCount: number;
  unavailable: boolean;
}

/** Every survey not yet decided for good — the set pass 2 keeps refreshing.
 * Unavailable rows stay in it so a rolled-back ref that reappears is cleared. */
export async function getHeldSurveys(db: D1Database): Promise<HeldSurvey[]> {
  const { results } = await db
    .prepare(
      `SELECT ref, end_epoch, tip_epoch, claimed_count, unavailable
       FROM survey WHERE final_state IS NULL`,
    )
    .all<{
      ref: string;
      end_epoch: number;
      tip_epoch: number;
      claimed_count: number;
      unavailable: number;
    }>();
  return results.map(r => ({
    ref: r.ref,
    endEpoch: r.end_epoch,
    tipEpoch: r.tip_epoch,
    claimedCount: r.claimed_count,
    unavailable: r.unavailable === 1,
  }));
}

export async function getKnownSurveyRefs(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT ref FROM survey').all<{ ref: string }>();
  return new Set(results.map(r => r.ref));
}

export interface NewSurvey {
  ref: string;
  topicId: string;
  title: string;
  endEpoch: number;
  eligibleRoles: readonly number[];
  sealed: boolean;
  cancelled: boolean;
  externalContent: boolean;
  /** Wire-form record JSON, stored verbatim so cip-179 can re-decode it. */
  definitionJson: string;
  claimedCount: number;
  finalState: string | null;
  tipEpoch: number;
  tesseraFetchedAt: number;
  submittedAt: number | null;
  now: number;
}

export function buildInsertSurvey(db: D1Database, s: NewSurvey): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO survey
         (ref, topic_id, title, end_epoch, eligible_roles, sealed, cancelled, external_content,
          definition, counted_dreps, claimed_count, final_state, audit_due_at, audit_attempts,
          unavailable, tip_epoch, tessera_fetched_at, submitted_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    )
    .bind(
      s.ref,
      s.topicId,
      s.title,
      s.endEpoch,
      JSON.stringify(s.eligibleRoles),
      s.sealed ? 1 : 0,
      s.cancelled ? 1 : 0,
      s.externalContent ? 1 : 0,
      s.definitionJson,
      s.claimedCount,
      s.finalState,
      s.now,
      s.tipEpoch,
      s.tesseraFetchedAt,
      s.submittedAt,
      s.now,
    );
}

export function buildInsertGovLink(
  db: D1Database,
  surveyRef: string,
  actionId: string,
  title: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO survey_gov_link (survey_ref, action_id, title) VALUES (?, ?, ?)
       ON CONFLICT(survey_ref, action_id) DO UPDATE SET title = excluded.title`,
    )
    .bind(surveyRef, actionId, title);
}

export function buildDeleteGovLinks(db: D1Database, surveyRef: string): D1PreparedStatement {
  return db.prepare('DELETE FROM survey_gov_link WHERE survey_ref = ?').bind(surveyRef);
}

/** The fields a Tessera answer refreshes on a held row. Reappearing clears
 * `unavailable` unconditionally: presence in a complete answer is the proof.
 * A non-null `auditDueAt` schedules an audit and restarts its backoff ladder
 * (the chain changed under the row, so past failures no longer describe it);
 * null leaves whatever schedule the row already carries. */
export interface SurveyRefresh {
  ref: string;
  claimedCount: number;
  cancelled: boolean;
  finalState: string | null;
  auditDueAt: number | null;
  tipEpoch: number;
  tesseraFetchedAt: number;
  now: number;
}

export function buildRefreshSurvey(db: D1Database, r: SurveyRefresh): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE survey SET claimed_count = ?, cancelled = ?, final_state = ?, unavailable = 0,
         audit_due_at = COALESCE(?, audit_due_at),
         audit_attempts = CASE WHEN ? IS NULL THEN audit_attempts ELSE 0 END,
         tip_epoch = ?, tessera_fetched_at = ?, synced_at = ?
       WHERE ref = ?`,
    )
    .bind(
      r.claimedCount,
      r.cancelled ? 1 : 0,
      r.finalState,
      r.auditDueAt,
      r.auditDueAt,
      r.tipEpoch,
      r.tesseraFetchedAt,
      r.now,
      r.ref,
    );
}

export async function markSurveysUnavailable(
  db: D1Database,
  refs: readonly string[],
  now: number,
): Promise<void> {
  // One bind is taken by `now`, the rest by the IN list.
  for (const chunk of chunked(refs, D1_MAX_BINDS - 1)) {
    await db
      .prepare(
        `UPDATE survey SET unavailable = 1, synced_at = ? WHERE ref IN (${sqlPlaceholders(chunk)})`,
      )
      .bind(now, ...chunk)
      .run();
  }
}

/** One due entry of the audit queue. `finalState`/`auditAttempts` are read
 * back so the sync can pick the outcome transition without a second query. */
export interface AuditDueSurvey {
  ref: string;
  finalState: string | null;
  auditAttempts: number;
}

/** The audits due now, oldest first — except decided rows, which cut the
 * line: their stored count is frozen wrong until their one post-final audit
 * lands (or is conceded), while a held row merely gets its next look late. */
export async function getAuditDueSurveys(
  db: D1Database,
  now: number,
  limit: number,
): Promise<AuditDueSurvey[]> {
  const { results } = await db
    .prepare(
      `SELECT ref, final_state, audit_attempts FROM survey
       WHERE audit_due_at IS NOT NULL AND audit_due_at <= ?
       ORDER BY (final_state IS NULL), audit_due_at
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ ref: string; final_state: string | null; audit_attempts: number }>();
  return results.map(r => ({
    ref: r.ref,
    finalState: r.final_state,
    auditAttempts: r.audit_attempts,
  }));
}

/** A successful audit: the count, the stamp, and the next look — a day out
 * for a held row (`nextDueAt`), never again (null) for a decided one. */
export async function markSurveyAudited(
  db: D1Database,
  ref: string,
  countedDreps: number,
  nextDueAt: number | null,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE survey SET counted_dreps = ?, audited_at = ?, audit_due_at = ?,
         audit_attempts = 0, synced_at = ?
       WHERE ref = ?`,
    )
    .bind(countedDreps, now, nextDueAt, now, ref)
    .run();
}

/** A failed audit attempt: count it and back off to `nextDueAt`. */
export async function markSurveyAuditFailed(
  db: D1Database,
  ref: string,
  nextDueAt: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE survey SET audit_attempts = audit_attempts + 1, audit_due_at = ?, synced_at = ?
       WHERE ref = ?`,
    )
    .bind(nextDueAt, now, ref)
    .run();
}

/** Stop auditing a survey for good. `clearCount` is set when a decided row
 * concedes: its stored count was never confirmed at-or-after finalization, so
 * it must show no number rather than a possibly wrong one. (A refresh trigger
 * can still revive the schedule if the chain changes under a held row.) */
export async function abandonSurveyAudit(
  db: D1Database,
  ref: string,
  clearCount: boolean,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE survey SET audit_due_at = NULL,
         counted_dreps = CASE WHEN ? = 1 THEN NULL ELSE counted_dreps END, synced_at = ?
       WHERE ref = ?`,
    )
    .bind(clearCount ? 1 : 0, now, ref)
    .run();
}

/**
 * Commit prepared statements in db.batch() calls whose summed bound-parameter
 * count stays at or under D1's 100-per-query cap, without splitting a group
 * (one survey's refresh + link statements commit atomically). Same conservative
 * cap reading as drepVotes.ts UPSERT_CHUNK; miniflare doesn't enforce it, so a
 * looser reading would only fail in production.
 */
export async function batchByBinds(
  db: D1Database,
  groups: readonly { statements: D1PreparedStatement[]; binds: number }[],
): Promise<void> {
  let pending: D1PreparedStatement[] = [];
  let pendingBinds = 0;
  for (const g of groups) {
    if (pending.length > 0 && pendingBinds + g.binds > D1_MAX_BINDS) {
      await db.batch(pending);
      pending = [];
      pendingBinds = 0;
    }
    pending.push(...g.statements);
    pendingBinds += g.binds;
  }
  if (pending.length > 0) await db.batch(pending);
}

/** One mirrored survey, as the pages read it (booleans decoded from 0/1). */
export interface SurveyRow {
  ref: string;
  topicId: string;
  title: string;
  endEpoch: number;
  /** CIP-179 role ints (DRep = 0). */
  eligibleRoles: number[];
  sealed: boolean;
  cancelled: boolean;
  externalContent: boolean;
  /** Wire-form record JSON; decode with cip-179's fromJsonSafe. */
  definitionJson: string;
  countedDreps: number | null;
  finalState: string | null;
  /** Next audit attempt (unix ms), null when none is scheduled — for a
   * decided row that means the count is settled, confirmed or conceded. */
  auditDueAt: number | null;
  unavailable: boolean;
  tipEpoch: number;
  /** Snapshot time (unix s) — the "as of" the UI shows. */
  tesseraFetchedAt: number;
  submittedAt: number | null;
}

interface RawSurveyRow {
  ref: string;
  topic_id: string;
  title: string;
  end_epoch: number;
  eligible_roles: string;
  sealed: number;
  cancelled: number;
  external_content: number;
  definition: string;
  counted_dreps: number | null;
  final_state: string | null;
  audit_due_at: number | null;
  unavailable: number;
  tip_epoch: number;
  tessera_fetched_at: number;
  submitted_at: number | null;
}

// Qualified with the table name so the list join (topics also has title/slug)
// stays unambiguous; single-table reads accept the qualification too.
const SURVEY_COLUMNS =
  'survey.ref, survey.topic_id, survey.title, survey.end_epoch, survey.eligible_roles, ' +
  'survey.sealed, survey.cancelled, survey.external_content, survey.definition, ' +
  'survey.counted_dreps, survey.final_state, survey.audit_due_at, survey.unavailable, ' +
  'survey.tip_epoch, ' +
  'survey.tessera_fetched_at, survey.submitted_at';

function rowToSurvey(r: RawSurveyRow): SurveyRow {
  return {
    ref: r.ref,
    topicId: r.topic_id,
    title: r.title,
    endEpoch: r.end_epoch,
    eligibleRoles: JSON.parse(r.eligible_roles) as number[],
    sealed: r.sealed === 1,
    cancelled: r.cancelled === 1,
    externalContent: r.external_content === 1,
    definitionJson: r.definition,
    countedDreps: r.counted_dreps,
    finalState: r.final_state,
    auditDueAt: r.audit_due_at,
    unavailable: r.unavailable === 1,
    tipEpoch: r.tip_epoch,
    tesseraFetchedAt: r.tessera_fetched_at,
    submittedAt: r.submitted_at,
  };
}

/** The survey behind one thread, or null for a non-survey topic. */
export async function getSurveyByTopicId(
  db: D1Database,
  topicId: string,
): Promise<SurveyRow | null> {
  const row = await db
    .prepare(`SELECT ${SURVEY_COLUMNS} FROM survey WHERE topic_id = ?`)
    .bind(topicId)
    .first<RawSurveyRow>();
  return row ? rowToSurvey(row) : null;
}

/** One list entry of the surveys category: the survey plus its thread's slug
 * and activity numbers, so the row can link and show replies without a join
 * per row. */
export interface SurveyListEntry {
  survey: SurveyRow;
  topicSlug: string;
  postCount: number;
  lastPostAt: number;
}

/** The surveys category list: newest publication first (a stable order that
 * needs no tip), paged. Deleted threads drop out with their topic. */
export async function listSurveysWithTopics(
  db: D1Database,
  opts: { limit: number; offset: number },
): Promise<SurveyListEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SURVEY_COLUMNS}, t.slug AS topic_slug, t.post_count, t.last_post_at
       FROM survey JOIN topics t ON t.id = survey.topic_id
       WHERE t.deleted = 0
       ORDER BY survey.submitted_at DESC, survey.ref
       LIMIT ? OFFSET ?`,
    )
    .bind(opts.limit, opts.offset)
    .all<RawSurveyRow & { topic_slug: string; post_count: number; last_post_at: number }>();
  return results.map(r => ({
    survey: rowToSurvey(r),
    topicSlug: r.topic_slug,
    postCount: r.post_count,
    lastPostAt: r.last_post_at,
  }));
}

/** One governance action linking a survey, resolved to its DRepTalk thread
 * when the action is imported. `title` is Tessera's extract from the action's
 * CIP-108 anchor — the fallback name for an action DRepTalk has not imported
 * (which can legitimately hold a link: admission needs only one match). */
export interface SurveyGovLinkView {
  actionId: string;
  title: string | null;
  actionTitle: string | null;
  topicSlug: string | null;
}

export async function getSurveyGovLinks(db: D1Database, ref: string): Promise<SurveyGovLinkView[]> {
  const { results } = await db
    .prepare(
      `SELECT l.action_id, l.title, ga.title AS action_title, t.slug AS topic_slug
       FROM survey_gov_link l
       LEFT JOIN governance_actions ga ON ga.proposal_id = l.action_id
       LEFT JOIN topics t ON t.id = ga.topic_id AND t.deleted = 0
       WHERE l.survey_ref = ?
       ORDER BY l.action_id`,
    )
    .bind(ref)
    .all<{
      action_id: string;
      title: string | null;
      action_title: string | null;
      topic_slug: string | null;
    }>();
  return results.map(r => ({
    actionId: r.action_id,
    title: r.title,
    actionTitle: r.action_title,
    topicSlug: r.topic_slug,
  }));
}

/** The admitted survey one governance action links — at most one by
 * construction (an action's anchor declares a single survey). Null when the
 * action links none, or links one that was never admitted. */
export async function getLinkedSurveyForAction(
  db: D1Database,
  proposalId: string,
): Promise<{ survey: SurveyRow; topicSlug: string } | null> {
  const row = await db
    .prepare(
      `SELECT ${SURVEY_COLUMNS}, t.slug AS topic_slug
       FROM survey_gov_link l
       JOIN survey ON survey.ref = l.survey_ref
       JOIN topics t ON t.id = survey.topic_id
       WHERE l.action_id = ? AND t.deleted = 0
       LIMIT 1`,
    )
    .bind(proposalId)
    .first<RawSurveyRow & { topic_slug: string }>();
  return row ? { survey: rowToSurvey(row), topicSlug: row.topic_slug } : null;
}

/** Thread slug for a survey ref — the /s/<ref> redirect target. */
export async function getTopicSlugBySurveyRef(db: D1Database, ref: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT t.slug FROM survey JOIN topics t ON t.id = survey.topic_id
       WHERE survey.ref = ? AND t.deleted = 0`,
    )
    .bind(ref)
    .first<{ slug: string }>();
  return row?.slug ?? null;
}

/** Whether a survey with this ref is mirrored here (any state). */
export async function surveyRefExists(db: D1Database, ref: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS x FROM survey WHERE ref = ?').bind(ref).first();
  return row !== null;
}

/**
 * Optimistic record of the viewer's own just-submitted answer, written by
 * POST /api/survey/response/record and settled (deleted) by the sync once
 * Tessera indexes the exact transaction. `failed` rows stay for the viewer's
 * own overlay ("didn't confirm — answer again"); a re-answer overwrites the
 * row via the (survey_ref, user_id) key, resetting it to pending.
 */
export interface LocalSurveyResponse {
  txHash: string;
  status: 'pending' | 'failed';
  createdAt: number;
}

export async function recordLocalSurveyResponse(
  db: D1Database,
  r: { surveyRef: string; userId: string; txHash: string; credential: string; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO survey_response_local
         (survey_ref, user_id, tx_hash, credential, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(r.surveyRef, r.userId, r.txHash, r.credential, r.now)
    .run();
}

/** The viewer's own local answer on one survey, for the card overlay. */
export async function getViewerSurveyResponse(
  db: D1Database,
  surveyRef: string,
  userId: string,
): Promise<LocalSurveyResponse | null> {
  const row = await db
    .prepare(
      'SELECT tx_hash, status, created_at FROM survey_response_local WHERE survey_ref = ? AND user_id = ?',
    )
    .bind(surveyRef, userId)
    .first<{ tx_hash: string; status: string; created_at: number }>();
  return row
    ? { txHash: row.tx_hash, status: row.status as 'pending' | 'failed', createdAt: row.created_at }
    : null;
}

export interface PendingSurveyResponse {
  surveyRef: string;
  userId: string;
  txHash: string;
  createdAt: number;
}

/** Every local answer still awaiting its transaction — the set pass 4 polls. */
export async function getPendingSurveyResponses(db: D1Database): Promise<PendingSurveyResponse[]> {
  const { results } = await db
    .prepare(
      `SELECT survey_ref, user_id, tx_hash, created_at
       FROM survey_response_local WHERE status = 'pending'`,
    )
    .all<{ survey_ref: string; user_id: string; tx_hash: string; created_at: number }>();
  return results.map(r => ({
    surveyRef: r.survey_ref,
    userId: r.user_id,
    txHash: r.tx_hash,
    createdAt: r.created_at,
  }));
}

/** Settles one local answer: the indexed on-chain response supersedes it. */
export async function deleteLocalSurveyResponse(
  db: D1Database,
  surveyRef: string,
  userId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM survey_response_local WHERE survey_ref = ? AND user_id = ?')
    .bind(surveyRef, userId)
    .run();
}

/** Flags pending answers older than the cutoff (unix ms) as failed: the tx
 * was dropped or rolled back, or it landed without a response for this survey.
 * Returns rows changed. */
export async function markStaleSurveyResponsesFailed(
  db: D1Database,
  cutoffMs: number,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE survey_response_local SET status = 'failed'
       WHERE status = 'pending' AND created_at < ?`,
    )
    .bind(cutoffMs)
    .run();
  return result.meta.changes ?? 0;
}

export interface SurveySyncState {
  /** Last seen size of Tessera's linked set (counts.linked), or null before the first walk. */
  linkedCount: number | null;
  /** When pass 1 last evaluated the complete linked list (unix ms). */
  lastFullWalkAt: number | null;
}

export async function getSurveySyncState(db: D1Database): Promise<SurveySyncState> {
  const row = await db
    .prepare('SELECT linked_count, last_full_walk_at FROM survey_sync_state WHERE id = 1')
    .first<{ linked_count: number | null; last_full_walk_at: number | null }>();
  return {
    linkedCount: row?.linked_count ?? null,
    lastFullWalkAt: row?.last_full_walk_at ?? null,
  };
}

export async function putSurveySyncState(db: D1Database, s: SurveySyncState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO survey_sync_state (id, linked_count, last_full_walk_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         linked_count = excluded.linked_count,
         last_full_walk_at = excluded.last_full_walk_at`,
    )
    .bind(s.linkedCount, s.lastFullWalkAt)
    .run();
}
