/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the survey tables (survey, survey_gov_link,
// survey_response_local, survey_sync_state). All queries use
// .prepare().bind(); never string-concatenated SQL. Rows are Tessera's answers
// written down; the sync (src/lib/surveys/sync.ts) is the only writer.

import { chunked, D1_MAX_BINDS, sqlPlaceholders } from './sql.js';

/** A held survey as the refresh pass compares it against Tessera's next
 * answer: every value a refresh can move, so an answer that moved none of
 * them writes nothing. */
export interface HeldSurvey {
  ref: string;
  countedDreps: number | null;
  cancelled: boolean;
  unavailable: boolean;
  /** Current gov links, action id → Tessera's title for the action. */
  links: Map<string, string | null>;
}

/** Every survey not yet decided for good — the set pass 2 keeps refreshing.
 * Unavailable rows stay in it so a reappearing ref is cleared, but only until
 * `retiredCutoff` (unix ms): without that exit a rolled-back record, which
 * never gets a final state, would be named in every ?refs= call for all time. */
export async function getHeldSurveys(db: D1Database, retiredCutoff: number): Promise<HeldSurvey[]> {
  const { results } = await db
    .prepare(
      `SELECT s.ref, s.counted_dreps, s.cancelled, s.unavailable, l.action_id, l.title
       FROM survey s LEFT JOIN survey_gov_link l ON l.survey_ref = s.ref
       WHERE s.final_state IS NULL AND (s.unavailable_since IS NULL OR s.unavailable_since > ?)
       ORDER BY s.ref`,
    )
    .bind(retiredCutoff)
    .all<{
      ref: string;
      counted_dreps: number | null;
      cancelled: number;
      unavailable: number;
      action_id: string | null;
      title: string | null;
    }>();
  const held = new Map<string, HeldSurvey>();
  for (const r of results) {
    let h = held.get(r.ref);
    if (!h) {
      h = {
        ref: r.ref,
        countedDreps: r.counted_dreps,
        cancelled: r.cancelled === 1,
        unavailable: r.unavailable === 1,
        links: new Map(),
      };
      held.set(r.ref, h);
    }
    if (r.action_id !== null) h.links.set(r.action_id, r.title);
  }
  return [...held.values()];
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
  countedDreps: number | null;
  finalState: string | null;
  artifactHash: string | null;
  submittedAt: number | null;
  now: number;
}

export function buildInsertSurvey(db: D1Database, s: NewSurvey): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO survey
         (ref, topic_id, title, end_epoch, eligible_roles, sealed, cancelled, external_content,
          definition, counted_dreps, final_state, artifact_hash, submitted_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      s.countedDreps,
      s.finalState,
      s.artifactHash,
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

/** The values a Tessera answer moves on a held row. Reappearing clears
 * `unavailable` unconditionally: presence in a complete answer is the proof. */
export interface SurveyRefresh {
  ref: string;
  countedDreps: number | null;
  cancelled: boolean;
  finalState: string | null;
  artifactHash: string | null;
  now: number;
}

export function buildRefreshSurvey(db: D1Database, r: SurveyRefresh): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE survey SET counted_dreps = ?, cancelled = ?, final_state = ?, artifact_hash = ?,
         unavailable = 0, unavailable_since = NULL, synced_at = ?
       WHERE ref = ?`,
    )
    .bind(r.countedDreps, r.cancelled ? 1 : 0, r.finalState, r.artifactHash, r.now, r.ref);
}

/** Withdraws held surveys the latest answer no longer admits: the flag hides
 * answering and starts the retirement clock, and the gov links go with it so
 * the linking action's thread stops naming the survey — a survey is listed
 * there only while an admitted link exists. The thread and row stay. Called
 * for rows not yet unavailable only, so the clock is set once. */
export async function markSurveysUnavailable(
  db: D1Database,
  refs: readonly string[],
  now: number,
): Promise<void> {
  // Two binds are taken by `now`, the rest by the IN list.
  for (const chunk of chunked(refs, D1_MAX_BINDS - 2)) {
    await db.batch([
      db
        .prepare(
          `UPDATE survey SET unavailable = 1, unavailable_since = ?, synced_at = ?
           WHERE ref IN (${sqlPlaceholders(chunk)})`,
        )
        .bind(now, now, ...chunk),
      db
        .prepare(`DELETE FROM survey_gov_link WHERE survey_ref IN (${sqlPlaceholders(chunk)})`)
        .bind(...chunk),
    ]);
  }
}

/** Finalized surveys whose artifact count is still to be read: the decision
 * has been written but the artifact request has not answered yet. Asked on
 * every run — the set is normally empty, and an artifact is immutable once
 * named, so a hash the list gave out is one the backend serves. */
export async function getSurveysAwaitingFinalCount(
  db: D1Database,
): Promise<{ ref: string; artifactHash: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT ref, artifact_hash FROM survey
       WHERE final_state = 'finalized' AND final_counted_dreps IS NULL
         AND artifact_hash IS NOT NULL
       ORDER BY ref`,
    )
    .all<{ ref: string; artifact_hash: string }>();
  return results.map(r => ({ ref: r.ref, artifactHash: r.artifact_hash }));
}

export async function setSurveyFinalCount(
  db: D1Database,
  ref: string,
  finalCountedDreps: number,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE survey SET final_counted_dreps = ?, synced_at = ? WHERE ref = ?')
    .bind(finalCountedDreps, now, ref)
    .run();
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
  /** The in-window DRep figure (Tessera's audited per-role count), null while
   * the backend serves none. */
  countedDreps: number | null;
  /** The DRep responders of the finalized tally artifact; null until read,
   * and forever on a cancelled or untalliable survey. */
  finalCountedDreps: number | null;
  finalState: string | null;
  unavailable: boolean;
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
  final_counted_dreps: number | null;
  final_state: string | null;
  unavailable: number;
  submitted_at: number | null;
}

// Qualified with the table name so the list join (topics also has title/slug)
// stays unambiguous; single-table reads accept the qualification too.
const SURVEY_COLUMNS =
  'survey.ref, survey.topic_id, survey.title, survey.end_epoch, survey.eligible_roles, ' +
  'survey.sealed, survey.cancelled, survey.external_content, survey.definition, ' +
  'survey.counted_dreps, survey.final_counted_dreps, survey.final_state, survey.unavailable, ' +
  'survey.submitted_at';

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
    finalCountedDreps: r.final_counted_dreps,
    finalState: r.final_state,
    unavailable: r.unavailable === 1,
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

/** One mirrored survey by its ref — what the record API decides
 * answerability from. Null when this mirror holds no such survey. */
export async function getSurveyByRef(db: D1Database, ref: string): Promise<SurveyRow | null> {
  const row = await db
    .prepare(`SELECT ${SURVEY_COLUMNS} FROM survey WHERE survey.ref = ?`)
    .bind(ref)
    .first<RawSurveyRow>();
  return row ? rowToSurvey(row) : null;
}

/**
 * Optimistic record of the viewer's own just-submitted answer, written by
 * POST /api/survey/response/record and settled (deleted) by the sync once
 * Tessera indexes the exact transaction. `failed` rows stay for the viewer's
 * own overlay ("didn't confirm — answer again") and keep being polled for a
 * while, since a transaction can land after the cutoff that failed the row; a
 * re-answer overwrites the row via the (survey_ref, user_id) key, resetting
 * it to pending.
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
  /** CIP-179 credential ("key:<hex>") the session derived at record time. */
  credential: string;
  createdAt: number;
}

/** The local answers whose transaction may still be indexed — the set pass 4
 * polls, bounded because it spends one request per distinct transaction.
 * Every pending row, plus the failed rows created after `failedSinceMs`: a
 * transaction can land after the cutoff that failed its row (an outage longer
 * than the cutoff fails every pending row at once), and a row that is never
 * looked at again would invite a second answer nobody needed. Pending rows
 * first, oldest first within each status, so a backlog of failed rows cannot
 * crowd a fresh answer out of the budget and delay its "confirming" going
 * away; what is left over waits one cron interval. */
export async function getSettleableSurveyResponses(
  db: D1Database,
  limit: number,
  failedSinceMs: number,
): Promise<PendingSurveyResponse[]> {
  const { results } = await db
    .prepare(
      `SELECT survey_ref, user_id, tx_hash, credential, created_at
       FROM survey_response_local
       WHERE status = 'pending' OR (status = 'failed' AND created_at > ?)
       ORDER BY status = 'pending' DESC, created_at, tx_hash
       LIMIT ?`,
    )
    .bind(failedSinceMs, limit)
    .all<{
      survey_ref: string;
      user_id: string;
      tx_hash: string;
      credential: string;
      created_at: number;
    }>();
  return results.map(r => ({
    surveyRef: r.survey_ref,
    userId: r.user_id,
    txHash: r.tx_hash,
    credential: r.credential,
    createdAt: r.created_at,
  }));
}

/** Settles one local answer: the indexed on-chain response supersedes it.
 * Keyed by the transaction as well, because a re-answer replaces the row
 * under the same (survey_ref, user_id) key while the pass is polling the old
 * transaction — deleting by key alone would settle the new claim on the old
 * evidence. Returns whether the row was still there to settle. */
export async function deleteLocalSurveyResponse(
  db: D1Database,
  surveyRef: string,
  userId: string,
  txHash: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      'DELETE FROM survey_response_local WHERE survey_ref = ? AND user_id = ? AND tx_hash = ?',
    )
    .bind(surveyRef, userId, txHash)
    .run();
  return (result.meta.changes ?? 0) > 0;
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
  /** Snapshot time (unix s) of the oldest Tessera answer the held rows were
   * last brought up to date with — the "as of" every survey page shows. Null
   * until a run has refreshed every held row. */
  tesseraFetchedAt: number | null;
}

export async function getSurveySyncState(db: D1Database): Promise<SurveySyncState> {
  const row = await db
    .prepare(
      'SELECT linked_count, last_full_walk_at, tessera_fetched_at FROM survey_sync_state WHERE id = 1',
    )
    .first<{
      linked_count: number | null;
      last_full_walk_at: number | null;
      tessera_fetched_at: number | null;
    }>();
  return {
    linkedCount: row?.linked_count ?? null,
    lastFullWalkAt: row?.last_full_walk_at ?? null,
    tesseraFetchedAt: row?.tessera_fetched_at ?? null,
  };
}

export async function putSurveySyncState(db: D1Database, s: SurveySyncState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO survey_sync_state (id, linked_count, last_full_walk_at, tessera_fetched_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         linked_count = excluded.linked_count,
         last_full_walk_at = excluded.last_full_walk_at,
         tessera_fetched_at = excluded.tessera_fetched_at`,
    )
    .bind(s.linkedCount, s.lastFullWalkAt, s.tesseraFetchedAt)
    .run();
}
