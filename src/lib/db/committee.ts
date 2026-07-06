// Read and write the constitutional committee membership timeline (the
// committee_member / committee_hot_key tables). getCommitteeTimeline loads the
// full timeline for the yes-percentage recompute; the upserts are used by the
// live Koios sync and the one-time historical seed. Distinct from
// koios/committee.ts, which is pure math on a single live committee_info snapshot.
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
