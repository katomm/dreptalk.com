/// <reference types="@cloudflare/workers-types" />
// Parameterized D1 access for badge_awards. Awards are permanent and monotonic:
// rows are only ever inserted or upgraded to a higher tier, never removed.

export type BadgeSubjectType = 'drep' | 'spo' | 'cc' | 'proposer' | 'user';

export interface BadgeAward {
  subjectType: BadgeSubjectType;
  subjectId: string;
  badgeId: string;
  /** 0 = untiered single award, 1/2/3 = bronze/silver/gold. */
  tier: number;
}

export interface BadgeAwardRow extends BadgeAward {
  awardedAt: number;
  upgradedAt: number | null;
}

interface RawRow {
  subject_type: BadgeSubjectType;
  subject_id: string;
  badge_id: string;
  tier: number;
  awarded_at: number;
  upgraded_at: number | null;
}

function rowToAward(r: RawRow): BadgeAwardRow {
  return {
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    badgeId: r.badge_id,
    tier: r.tier,
    awardedAt: r.awarded_at,
    upgradedAt: r.upgraded_at,
  };
}

/** Every award row; the engine diffs desired state against this in memory. */
export async function getAllAwards(db: D1Database): Promise<BadgeAwardRow[]> {
  const res = await db
    .prepare('SELECT subject_type, subject_id, badge_id, tier, awarded_at, upgraded_at FROM badge_awards')
    .all<RawRow>();
  return (res.results ?? []).map(rowToAward);
}

/** Awards of one subject (a profile page's earned badges). */
export async function getSubjectAwards(
  db: D1Database,
  subjectType: BadgeSubjectType,
  subjectId: string,
): Promise<BadgeAwardRow[]> {
  const res = await db
    .prepare(
      `SELECT subject_type, subject_id, badge_id, tier, awarded_at, upgraded_at
       FROM badge_awards WHERE subject_type = ? AND subject_id = ?`,
    )
    .bind(subjectType, subjectId)
    .all<RawRow>();
  return (res.results ?? []).map(rowToAward);
}

// Bound parameters per row in the upsert; stays well under the SQLite limit.
const UPSERT_CHUNK = 100;

/**
 * Writes awards. The engine only passes new awards and tier upgrades; the
 * conflict clause keeps the write monotonic even under concurrent runs
 * (a lower or equal tier never overwrites a higher one).
 */
export async function applyAwards(db: D1Database, awards: BadgeAward[], now: number): Promise<number> {
  if (awards.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO badge_awards (subject_type, subject_id, badge_id, tier, awarded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (subject_type, subject_id, badge_id) DO UPDATE
       SET tier = excluded.tier, upgraded_at = excluded.awarded_at
       WHERE excluded.tier > badge_awards.tier`,
  );
  for (let i = 0; i < awards.length; i += UPSERT_CHUNK) {
    const chunk = awards.slice(i, i + UPSERT_CHUNK);
    await db.batch(chunk.map((a) => stmt.bind(a.subjectType, a.subjectId, a.badgeId, a.tier, now)));
  }
  return awards.length;
}
