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
  countedDreps: number | null;
  unavailable: boolean;
}

/** Every survey not yet decided for good — the set pass 2 keeps refreshing.
 * Unavailable rows stay in it so a rolled-back ref that reappears is cleared. */
export async function getHeldSurveys(db: D1Database): Promise<HeldSurvey[]> {
  const { results } = await db
    .prepare(
      `SELECT ref, end_epoch, tip_epoch, claimed_count, counted_dreps, unavailable
       FROM survey WHERE final_state IS NULL`,
    )
    .all<{
      ref: string;
      end_epoch: number;
      tip_epoch: number;
      claimed_count: number;
      counted_dreps: number | null;
      unavailable: number;
    }>();
  return results.map(r => ({
    ref: r.ref,
    endEpoch: r.end_epoch,
    tipEpoch: r.tip_epoch,
    claimedCount: r.claimed_count,
    countedDreps: r.counted_dreps,
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
          definition, counted_dreps, claimed_count, final_state, unavailable, tip_epoch,
          tessera_fetched_at, submitted_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?)`,
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
 * `unavailable` unconditionally: presence in a complete answer is the proof. */
export interface SurveyRefresh {
  ref: string;
  claimedCount: number;
  cancelled: boolean;
  finalState: string | null;
  tipEpoch: number;
  tesseraFetchedAt: number;
  now: number;
}

export function buildRefreshSurvey(db: D1Database, r: SurveyRefresh): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE survey SET claimed_count = ?, cancelled = ?, final_state = ?, unavailable = 0,
         tip_epoch = ?, tessera_fetched_at = ?, synced_at = ?
       WHERE ref = ?`,
    )
    .bind(
      r.claimedCount,
      r.cancelled ? 1 : 0,
      r.finalState,
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

export async function updateCountedDreps(
  db: D1Database,
  ref: string,
  countedDreps: number,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE survey SET counted_dreps = ?, synced_at = ? WHERE ref = ?')
    .bind(countedDreps, now, ref)
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

export interface SurveySyncState {
  /** Last seen size of Tessera's linked set (counts.linked), or null before the first walk. */
  linkedCount: number | null;
  /** When pass 1 last evaluated the complete linked list (unix ms). */
  lastFullWalkAt: number | null;
  /** When pass 3 last ran its unconditional re-audit over every held survey (unix ms). */
  lastAuditAt: number | null;
}

export async function getSurveySyncState(db: D1Database): Promise<SurveySyncState> {
  const row = await db
    .prepare(
      'SELECT linked_count, last_full_walk_at, last_audit_at FROM survey_sync_state WHERE id = 1',
    )
    .first<{
      linked_count: number | null;
      last_full_walk_at: number | null;
      last_audit_at: number | null;
    }>();
  return {
    linkedCount: row?.linked_count ?? null,
    lastFullWalkAt: row?.last_full_walk_at ?? null,
    lastAuditAt: row?.last_audit_at ?? null,
  };
}

export async function putSurveySyncState(db: D1Database, s: SurveySyncState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO survey_sync_state (id, linked_count, last_full_walk_at, last_audit_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         linked_count = excluded.linked_count,
         last_full_walk_at = excluded.last_full_walk_at,
         last_audit_at = excluded.last_audit_at`,
    )
    .bind(s.linkedCount, s.lastFullWalkAt, s.lastAuditAt)
    .run();
}
