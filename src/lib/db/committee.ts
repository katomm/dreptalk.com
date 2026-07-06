// Read and write the constitutional committee membership timeline (the
// committee_member / committee_hot_key tables). getCommitteeTimeline loads the
// full timeline for the yes-percentage recompute; the upserts are used by the
// live Koios sync and the one-time historical seed. Distinct from
// koios/committee.ts, which is pure math on a single live committee_info snapshot.
import type { CommitteeMember } from '../koios/client.js';
import type { CommitteeMemberTerm } from '../koios/committeeTimeline.js';

interface MemberRow {
  cold_key_hex: string;
  version_from: number;
  version_to: number | null;
  term_expiration: number;
  authorized_from: number;
  resigned_at: number | null;
}

/** Loads every committee member (all versions) and the hot-key to cold-key map. */
export async function getCommitteeTimeline(
  db: D1Database,
): Promise<{ members: CommitteeMemberTerm[]; hotToCold: Map<string, string> }> {
  const [memberRes, hotRes] = await Promise.all([
    db
      .prepare(
        'SELECT cold_key_hex, version_from, version_to, term_expiration, authorized_from, resigned_at FROM committee_member',
      )
      .all<MemberRow>(),
    db.prepare('SELECT hot_key_hex, cold_key_hex FROM committee_hot_key').all<{ hot_key_hex: string; cold_key_hex: string }>(),
  ]);

  const members: CommitteeMemberTerm[] = (memberRes.results ?? []).map((r) => ({
    coldKeyHex: r.cold_key_hex,
    versionFrom: r.version_from,
    versionTo: r.version_to,
    termExpiration: r.term_expiration,
    authorizedFrom: r.authorized_from,
    resignedAt: r.resigned_at,
  }));

  const hotToCold = new Map<string, string>();
  for (const h of hotRes.results ?? []) hotToCold.set(h.hot_key_hex, h.cold_key_hex);
  return { members, hotToCold };
}

/** Upserts committee members. Chunked at 16 rows (6 binds each) to stay under D1's 100-bind cap. */
export async function upsertCommitteeMembers(db: D1Database, members: CommitteeMemberTerm[]): Promise<void> {
  const CHUNK = 16;
  for (let i = 0; i < members.length; i += CHUNK) {
    const stmts = members.slice(i, i + CHUNK).map((m) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO committee_member
             (cold_key_hex, version_from, version_to, term_expiration, authorized_from, resigned_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(m.coldKeyHex, m.versionFrom, m.versionTo, m.termExpiration, m.authorizedFrom, m.resignedAt),
    );
    if (stmts.length > 0) await db.batch(stmts);
  }
}

/** Upserts hot-key to cold-key mappings. Chunked at 50 rows (2 binds each). */
export async function upsertCommitteeHotKeys(
  db: D1Database,
  pairs: { hotKeyHex: string; coldKeyHex: string }[],
): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const stmts = pairs
      .slice(i, i + CHUNK)
      .map((p) =>
        db
          .prepare('INSERT OR REPLACE INTO committee_hot_key (hot_key_hex, cold_key_hex) VALUES (?, ?)')
          .bind(p.hotKeyHex, p.coldKeyHex),
      );
    if (stmts.length > 0) await db.batch(stmts);
  }
}

/**
 * Keeps the current committee version fresh from a live Koios committee_info
 * snapshot: registers newly rotated hot keys, updates the current members' term
 * expiration, and records a new resignation (a member no longer 'authorized').
 * The historical seed is protected: resigned_at is only ever set when still null
 * (COALESCE), so a past resignation epoch is never overwritten with "now", and
 * only rows of the current version (version_to IS NULL) are touched. `unknown`
 * counts Koios members absent from the current version, the signal that a new
 * committee was enacted and the seed needs extending (mirrors the NCL rot-alarm).
 */
export async function syncCurrentCommitteeMembership(
  db: D1Database,
  members: CommitteeMember[],
  currentEpoch: number | null,
): Promise<{ hotKeys: number; updated: number; unknown: number }> {
  const hotPairs = members
    .filter((m): m is CommitteeMember & { cc_hot_hex: string; cc_cold_hex: string } => !!m.cc_hot_hex && !!m.cc_cold_hex)
    .map((m) => ({ hotKeyHex: m.cc_hot_hex, coldKeyHex: m.cc_cold_hex }));
  await upsertCommitteeHotKeys(db, hotPairs);

  let updated = 0;
  let unknown = 0;
  for (const m of members) {
    if (!m.cc_cold_hex) continue;
    const resignedNow = m.status !== 'authorized' && currentEpoch != null ? currentEpoch : null;
    const res = await db
      .prepare(
        `UPDATE committee_member
           SET term_expiration = COALESCE(?, term_expiration),
               resigned_at = COALESCE(resigned_at, ?)
         WHERE cold_key_hex = ? AND version_to IS NULL`,
      )
      .bind(m.expiration_epoch, resignedNow, m.cc_cold_hex)
      .run();
    if ((res.meta.changes ?? 0) > 0) updated++;
    else unknown++;
  }
  return { hotKeys: hotPairs.length, updated, unknown };
}
