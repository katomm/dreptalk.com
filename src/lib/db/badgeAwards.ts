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

/**
 * Posts that count toward forum and crossover badges. Vote rationales are
 * ingested from chain rather than written on the forum, so they never earn
 * forum badges. The awarding engine and the live progress counters MUST apply
 * this identically: when they drift, a progress bar fills to its goal on posts
 * the engine refuses to count and the badge never unlocks.
 *
 * `alias` is the posts table alias used by the query, empty for an unaliased one.
 */
export const countablePostSql = (alias = ''): string => {
  const p = alias ? `${alias}.` : '';
  return `${p}deleted = 0 AND ${p}hidden = 0 AND (${p}source IS NULL OR ${p}source != 'vote_rationale')`;
};

// Live counters the gallery shows progress bars for; everything else (streaks,
// one-off events, registry badges) renders without a bar.
export interface BadgeCounters {
  votes: number;
  rationale: number;
  types: number;
  cross: number;
  crossRationale: number;
  crossDeliberated: number;
  posts: number;
  ups: number;
  maxUp: number;
  topics: number;
  govTopics: number;
}

/** Per-subject progress counters, computed live at render time. */
export async function loadBadgeCounters(db: D1Database, drepId: string, userId: string | null): Promise<BadgeCounters> {
  const [votes, types, cross, posts, topics, govTopics] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN meta_url IS NOT NULL AND meta_url != '' THEN 1 ELSE 0 END) AS r
         FROM drep_votes WHERE voter_id = ? AND voter_role = 'DRep'`,
      )
      .bind(drepId)
      .first<{ n: number; r: number | null }>(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT g.type) AS n FROM drep_votes v
         JOIN governance_actions g ON g.id = v.ga_id
         WHERE v.voter_id = ? AND v.voter_role = 'DRep'`,
      )
      .bind(drepId)
      .first<{ n: number }>(),
    userId
      ? db
          .prepare(
            `SELECT g.id AS ga, MIN(p.created_at) AS first_ms, v.block_time AS bt,
                    MAX(CASE WHEN v.meta_url IS NOT NULL AND v.meta_url != '' THEN 1 ELSE 0 END) AS rat
             FROM posts p
             JOIN governance_actions g ON g.topic_id = p.topic_id
             JOIN drep_votes v ON v.ga_id = g.id AND v.voter_id = ?1 AND v.voter_role = 'DRep'
             WHERE p.author_id = ?2 AND ${countablePostSql('p')}
             GROUP BY g.id, v.block_time`,
          )
          .bind(drepId, userId)
          .all<{ ga: string; first_ms: number; bt: number | null; rat: number }>()
      : Promise.resolve(null),
    userId
      ? db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(up_count), 0) AS ups, COALESCE(MAX(up_count), 0) AS maxup
             FROM posts WHERE author_id = ? AND ${countablePostSql()}`,
          )
          .bind(userId)
          .first<{ n: number; ups: number; maxup: number }>()
      : Promise.resolve(null),
    userId
      ? db
          .prepare(`SELECT COUNT(*) AS n FROM topics WHERE author_id = ? AND deleted = 0 AND source = 'user'`)
          .bind(userId)
          .first<{ n: number }>()
      : Promise.resolve(null),
    userId
      ? db
          .prepare(
            `SELECT COUNT(DISTINCT p.topic_id) AS n FROM posts p
             JOIN governance_actions g ON g.topic_id = p.topic_id
             WHERE p.author_id = ? AND ${countablePostSql('p')}`,
          )
          .bind(userId)
          .first<{ n: number }>()
      : Promise.resolve(null),
  ]);

  const crossRows = cross?.results ?? [];
  return {
    votes: votes?.n ?? 0,
    rationale: votes?.r ?? 0,
    types: types?.n ?? 0,
    cross: crossRows.length,
    crossRationale: crossRows.filter((r) => r.rat).length,
    crossDeliberated: crossRows.filter((r) => r.bt != null && r.first_ms < r.bt * 1000).length,
    posts: posts?.n ?? 0,
    ups: posts?.ups ?? 0,
    maxUp: posts?.maxup ?? 0,
    topics: topics?.n ?? 0,
    govTopics: govTopics?.n ?? 0,
  };
}

/**
 * Holders per badge id, for the /badges overview and rarity-ranked showcases.
 * Reads the materialized `badge_holder_counts` table (refreshed by the hourly
 * badges cron via refreshBadgeHolderCounts). When the table is empty (fresh
 * deploy before the first refresh, or local dev), falls back to computing the
 * live aggregate so callers never see an all-zero result.
 */
export async function getBadgeHolderCounts(db: D1Database): Promise<Map<string, number>> {
  const cached = await db
    .prepare('SELECT badge_id, n FROM badge_holder_counts')
    .all<{ badge_id: string; n: number }>();
  const rows = cached.results ?? [];
  if (rows.length > 0) return new Map(rows.map((r) => [r.badge_id, r.n]));
  const live = await db
    .prepare('SELECT badge_id, COUNT(*) AS n FROM badge_awards GROUP BY badge_id')
    .all<{ badge_id: string; n: number }>();
  return new Map((live.results ?? []).map((r) => [r.badge_id, r.n]));
}

/**
 * Recomputes badge_holder_counts from badge_awards. Called at the end of the
 * hourly badges cron after applyAwards, so the materialized snapshot is always
 * at most one cron cycle stale. The refresh runs in one batched round trip: a
 * DELETE-all followed by an INSERT of the fresh aggregate, chunked to respect
 * D1's bound-parameter cap (100 params per call, 3 per row here).
 */
export async function refreshBadgeHolderCounts(db: D1Database, now: number): Promise<number> {
  const live = await db
    .prepare('SELECT badge_id, COUNT(*) AS n FROM badge_awards GROUP BY badge_id')
    .all<{ badge_id: string; n: number }>();
  const rows = live.results ?? [];
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM badge_holder_counts')];
  const CHUNK = 30;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map(() => '(?, ?, ?)').join(', ');
    const binds = chunk.flatMap((r) => [r.badge_id, r.n, now]);
    stmts.push(db.prepare(`INSERT INTO badge_holder_counts (badge_id, n, updated_at) VALUES ${values}`).bind(...binds));
  }
  await db.batch(stmts);
  return rows.length;
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
