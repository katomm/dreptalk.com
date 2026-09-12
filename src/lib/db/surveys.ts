/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for the survey tables (survey, survey_gov_link,
// survey_sync_state). All queries use .prepare().bind(); never
// string-concatenated SQL. Rows are Tessera's answers written down. The sync
// (src/lib/surveys/sync.ts) is the only writer.

import { chunked, D1_MAX_BINDS, sqlPlaceholders } from './sql.js';

/** A survey as the mirror writes it: Tessera's answer, no thread of its own
 * yet, the thread is opened later, over the stored rows. */
export interface NewSurvey {
  ref: string;
  endEpoch: number;
  eligibleRoles: readonly number[];
  sealed: boolean;
  cancelled: boolean;
  externalContent: boolean;
  /** The record in cip-179's own wire form, never sanitized or capped: the
   * widget re-decodes it as cip-179 serialized it. */
  definitionJson: string;
  countedDreps: number | null;
  finalState: string | null;
  artifactHash: string | null;
  submittedAt: number;
  now: number;
}

/** Writes down one survey the mirror was given: an insert the first time, and
 * an update of what Tessera can move on every later delivery. The record's own
 * columns are deliberately not in the update list, a CIP-179 record is
 * immutable under its ref, and the stored wire form is what the widget
 * re-decodes, so re-deriving them per delivery could only introduce drift.
 * `final_counted_dreps` is the artifact pass's alone, except that a delivery
 * moving `artifact_hash` resets it: the count must describe the artifact
 * named beside it, so the pass reads the new one. Reappearing clears
 * `unavailable` unconditionally: being in an answer at all is the proof. */
export function buildUpsertSurvey(db: D1Database, s: NewSurvey): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO survey
         (ref, end_epoch, eligible_roles, sealed, cancelled, external_content,
          definition, counted_dreps, final_state, artifact_hash, submitted_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         counted_dreps = excluded.counted_dreps,
         cancelled = excluded.cancelled,
         final_state = excluded.final_state,
         final_counted_dreps = CASE
           WHEN excluded.artifact_hash IS survey.artifact_hash THEN survey.final_counted_dreps
         END,
         artifact_hash = excluded.artifact_hash,
         unavailable = 0,
         synced_at = excluded.synced_at`,
    )
    .bind(
      s.ref,
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

/** A stored survey a linking action now imported entitles to a thread: what
 * the publish step needs to open one from the row alone, with no Tessera
 * request, the record it stored and the publication time it projected. */
export interface PublishableSurvey {
  ref: string;
  definitionJson: string;
  externalContent: boolean;
  submittedAt: number;
}

/** DRepTalk's half of admission, asked of the stored rows: a survey with no
 * thread yet that at least one imported governance action links. Every step
 * is an index probe (the NULL group of idx_survey_topic, empty in steady
 * state, the link table's primary key, idx_governance_actions_proposal_id),
 * so asking on every run costs nothing while nothing is pending. Oldest
 * publication first, so a backlog opens its threads in chain order. */
export async function getPublishableSurveys(db: D1Database): Promise<PublishableSurvey[]> {
  const { results } = await db
    .prepare(
      `SELECT ref, definition, external_content, submitted_at
       FROM survey
       WHERE topic_id IS NULL
         AND EXISTS (
           SELECT 1 FROM survey_gov_link l
           JOIN governance_actions ga ON ga.proposal_id = l.action_id
           WHERE l.survey_ref = survey.ref
         )
       ORDER BY submitted_at, ref`,
    )
    .all<{
      ref: string;
      definition: string;
      external_content: number;
      submitted_at: number;
    }>();
  return results.map(r => ({
    ref: r.ref,
    definitionJson: r.definition,
    externalContent: r.external_content === 1,
    submittedAt: r.submitted_at,
  }));
}

/** Publication: the row takes the thread just opened for it. Batched with the
 * topic and first post by createTopic, so a partial write can neither orphan
 * a thread nor publish a survey twice. */
export function buildPublishSurvey(
  db: D1Database,
  ref: string,
  topicId: string,
): D1PreparedStatement {
  return db
    .prepare('UPDATE survey SET topic_id = ? WHERE ref = ? AND topic_id IS NULL')
    .bind(topicId, ref);
}

/** Withdraws the surveys the latest answer no longer lists as eligible, a
 * rolled-back record, its links gone, a key removed upstream. What withdrawal
 * does depends on what there is to preserve, and that is a fact on the row:
 * a survey with a thread keeps it and takes the `unavailable` flag, which
 * hides answering until presence in a later answer clears it. One with no
 * thread is deleted, since an advisory removal delivers it again. Asking
 * `topic_id IS NULL` in the statements that act is what lets the sync withdraw
 * a list of keys without knowing anything about them: refs never stored are
 * no-ops, and an already-withdrawn row is untouched, so `unavailable` dates
 * from the first withdrawal. The gov links go either way, a rolled-back
 * action must stop naming the survey on its thread. Returns the rows
 * withdrawn. */
export async function withdrawSurveys(
  db: D1Database,
  refs: readonly string[],
  now: number,
): Promise<number> {
  let withdrawn = 0;
  // The widest statement binds `now` plus the IN list, and the cap is per
  // statement, not summed across the batch.
  for (const chunk of chunked(refs, D1_MAX_BINDS - 1)) {
    const list = sqlPlaceholders(chunk);
    const [, deleted, flagged] = await db.batch([
      db.prepare(`DELETE FROM survey_gov_link WHERE survey_ref IN (${list})`).bind(...chunk),
      db.prepare(`DELETE FROM survey WHERE ref IN (${list}) AND topic_id IS NULL`).bind(...chunk),
      db
        .prepare(
          `UPDATE survey SET unavailable = 1, synced_at = ?
           WHERE ref IN (${list}) AND topic_id IS NOT NULL AND unavailable = 0`,
        )
        .bind(now, ...chunk),
    ]);
    withdrawn += (deleted.meta.changes ?? 0) + (flagged.meta.changes ?? 0);
  }
  return withdrawn;
}

/** Finalized surveys whose artifact count is still to be read: the decision
 * has been written but the artifact request has not answered yet. Asked on
 * every run, the set is normally empty, and an artifact is immutable once
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

/** Writes the figure read from one artifact, against the row that still names
 * that artifact. The hash is part of the predicate because the count belongs
 * to the artifact it was read from: an overlapping mirror can re-finalize the
 * survey onto a second artifact while the request for the first is in flight,
 * and a count written beside the newer hash would be wrong for good, a row
 * that has one never being asked about again. False says the row moved on,
 * which leaves it awaiting and the next run reads the artifact it now names. */
export async function setSurveyFinalCount(
  db: D1Database,
  ref: string,
  artifactHash: string,
  finalCountedDreps: number,
  now: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE survey SET final_counted_dreps = ?, synced_at = ?
       WHERE ref = ? AND artifact_hash = ? AND final_counted_dreps IS NULL`,
    )
    .bind(finalCountedDreps, now, ref, artifactHash)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** One published survey, as the pages read it (booleans decoded from 0/1).
 * Every reader joins topics, so a row stored but not yet published, its
 * thread waits for a linking action to be imported, never takes this shape.
 * The thread's own title and slug come from that join where a reader shows
 * them. */
export interface SurveyRow {
  ref: string;
  endEpoch: number;
  /** CIP-179 role ints (DRep = 0). */
  eligibleRoles: number[];
  sealed: boolean;
  cancelled: boolean;
  externalContent: boolean;
  /** Wire-form record JSON; decode with cip-179's decodeSurveyRecord. */
  definitionJson: string;
  /** The in-window DRep figure (Tessera's audited per-role count), null while
   * the backend serves none. */
  countedDreps: number | null;
  /** The DRep responders of the finalized tally artifact, null until read,
   * and forever on a cancelled or untalliable survey. */
  finalCountedDreps: number | null;
  finalState: string | null;
  unavailable: boolean;
}

interface RawSurveyRow {
  ref: string;
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
}

// Qualified with the table name so the reads that join topics stay
// unambiguous. Single-table reads accept the qualification too.
const SURVEY_COLUMNS =
  'survey.ref, survey.end_epoch, survey.eligible_roles, survey.sealed, survey.cancelled, ' +
  'survey.external_content, survey.definition, survey.counted_dreps, ' +
  'survey.final_counted_dreps, survey.final_state, survey.unavailable';

function rowToSurvey(r: RawSurveyRow): SurveyRow {
  return {
    ref: r.ref,
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

/** One list entry of the surveys category: the survey plus its thread's
 * title, slug and activity numbers, so the row can name, link and show
 * replies without a join per row. */
export interface SurveyListEntry {
  survey: SurveyRow;
  topicTitle: string;
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
      `SELECT ${SURVEY_COLUMNS}, t.title AS topic_title, t.slug AS topic_slug,
              t.post_count, t.last_post_at
       FROM survey JOIN topics t ON t.id = survey.topic_id
       WHERE t.deleted = 0
       ORDER BY survey.submitted_at DESC, survey.ref
       LIMIT ? OFFSET ?`,
    )
    .bind(opts.limit, opts.offset)
    .all<
      RawSurveyRow & {
        topic_title: string;
        topic_slug: string;
        post_count: number;
        last_post_at: number;
      }
    >();
  return results.map(r => ({
    survey: rowToSurvey(r),
    topicTitle: r.topic_title,
    topicSlug: r.topic_slug,
    postCount: r.post_count,
    lastPostAt: r.last_post_at,
  }));
}

/** One governance action linking a survey, resolved to its DRepTalk thread
 * when the action is imported. `title` is Tessera's extract from the action's
 * CIP-108 anchor, sanitized and capped at write like the survey's own, the
 * fallback name for an action DRepTalk has not imported
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

/** The published survey one governance action links, at most one by
 * construction (an action's anchor declares a single survey). Null when the
 * action links none, or links one that was never published. */
export async function getLinkedSurveyForAction(
  db: D1Database,
  proposalId: string,
): Promise<{ survey: SurveyRow; topicTitle: string; topicSlug: string } | null> {
  const row = await db
    .prepare(
      `SELECT ${SURVEY_COLUMNS}, t.title AS topic_title, t.slug AS topic_slug
       FROM survey_gov_link l
       JOIN survey ON survey.ref = l.survey_ref
       JOIN topics t ON t.id = survey.topic_id
       WHERE l.action_id = ? AND t.deleted = 0
       LIMIT 1`,
    )
    .bind(proposalId)
    .first<RawSurveyRow & { topic_title: string; topic_slug: string }>();
  return row
    ? { survey: rowToSurvey(row), topicTitle: row.topic_title, topicSlug: row.topic_slug }
    : null;
}

/** Thread slug for a survey ref, the /s/<ref> redirect target. */
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

export interface SurveySyncState {
  /** Where Tessera's change selection continues from, opaque, minted by the
   * backend, or null until the first run's bootstrap has been applied to its
   * end. Never expires: the backend keeps its tombstones for the life of the
   * corpus. */
  changesCursor: string | null;
  /** Snapshot time (unix s) of the last Tessera answer this mirror applied,
   * the "as of" every survey page shows. Null until a run has applied a delta
   * to its end. */
  tesseraFetchedAt: number | null;
  /** Whether that snapshot was short: the scan behind it could not read every
   * matching record, so the rows are a prefix of on-chain state and any count
   * taken from them may be low. Written only by a run that advances
   * `tesseraFetchedAt`, so the two always describe the same snapshot. */
  incomplete: boolean;
}

export async function getSurveySyncState(db: D1Database): Promise<SurveySyncState> {
  const row = await db
    .prepare(
      'SELECT changes_cursor, tessera_fetched_at, incomplete FROM survey_sync_state WHERE id = 1',
    )
    .first<{
      changes_cursor: string | null;
      tessera_fetched_at: number | null;
      incomplete: number;
    }>();
  return {
    changesCursor: row?.changes_cursor ?? null,
    tesseraFetchedAt: row?.tessera_fetched_at ?? null,
    incomplete: row?.incomplete === 1,
  };
}

export async function putSurveySyncState(db: D1Database, s: SurveySyncState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO survey_sync_state (id, changes_cursor, tessera_fetched_at, incomplete)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         changes_cursor = excluded.changes_cursor,
         tessera_fetched_at = excluded.tessera_fetched_at,
         incomplete = excluded.incomplete`,
    )
    .bind(s.changesCursor, s.tesseraFetchedAt, s.incomplete ? 1 : 0)
    .run();
}
