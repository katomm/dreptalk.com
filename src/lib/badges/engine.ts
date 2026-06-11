/// <reference types="@cloudflare/workers-types" />
// Achievement badge awarding engine. Runs in the gov-sync cron (hourly, after
// the vote sync): computes the desired award state for every subject with a
// handful of set-based aggregates, diffs against badge_awards in memory, and
// writes only new awards and tier upgrades. Awards are permanent and monotonic,
// so shrinking counters (deleted posts, re-synced votes) never revoke anything.
//
// Principles (see config/badges.ts for the catalog): no badge depends on the
// direction of a vote, criteria are counts rather than rates, on-chain badges
// attach to the on-chain identity and forum badges to the user id.

import { BADGES } from '../../../config/badges.js';
import { EPOCH_LENGTH_SECONDS, epochFromUnix, type NetworkConfig } from '../config/network.js';
import { GOV_SYNC_AUTHOR } from '../governance/sync.js';
import { applyAwards, getAllAwards, type BadgeAward, type BadgeSubjectType } from '../db/badgeAwards.js';

export interface BadgeRunResult {
  /** Awards the current data justifies (including already-awarded ones). */
  desired: number;
  /** New awards plus tier upgrades actually written. */
  written: number;
}

// Epochs in one year (73 x 5 days) and the streak tier unit used in the catalog.
const VETERAN_EPOCHS = 73;
// First epochs of the Conway era: mainnet entered governance at epoch 507
// (Chang, Sept 2024), preprod around epoch 163. The badge covers roughly the
// first two months of DRep registrations.
const GENESIS_EPOCH_LIMIT: Record<string, number> = { mainnet: 520, preprod: 175 };
const NECRO_DORMANT_MS = 60 * 86_400_000;
const BOUNDARY_WINDOW_SECONDS = 600;

const ROLE_SUBJECT: Record<string, BadgeSubjectType> = {
  DRep: 'drep',
  SPO: 'spo',
  ConstitutionalCommittee: 'cc',
};

function tierFor(n: number, tiers: [number, number, number]): number {
  if (n >= tiers[2]) return 3;
  if (n >= tiers[1]) return 2;
  if (n >= tiers[0]) return 1;
  return 0;
}

const TIERS_BY_BADGE = new Map(BADGES.filter((b) => b.tiers).map((b) => [b.id, b.tiers as [number, number, number]]));

function tiersOf(badgeId: string): [number, number, number] {
  const tiers = TIERS_BY_BADGE.get(badgeId);
  if (!tiers) throw new Error(`badge ${badgeId} has no tiers`);
  return tiers;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) map.set(key, (v = make()));
  return v;
}

// SQL fragment deriving the epoch number from a unix-seconds expression.
// Binds: ?1 = anchor unix seconds, ?2 = anchor epoch (cfg.epochAnchor).
const epochSql = (unixSecondsExpr: string) => `CAST((${unixSecondsExpr} - ?1) / ${EPOCH_LENGTH_SECONDS} AS INTEGER) + ?2`;

/** Longest run of strictly consecutive epoch numbers (forum streak). */
export function longestConsecutiveRun(epochs: number[]): number {
  const sorted = [...new Set(epochs)].sort((a, b) => a - b);
  let best = 0;
  let runStart = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1] + 1) runStart = i;
    best = Math.max(best, sorted[i] - sorted[runStart] + 1);
  }
  return best;
}

/**
 * Longest covered span for the iron streak, in calendar epochs: over the
 * eligible epochs (ascending, each with a known action total), a span runs from
 * the first fully-voted epoch to the last one without a partial or missed
 * eligible epoch in between. Epochs without decided actions bridge the span.
 */
export function longestCoveredSpan(
  eligibleEpochs: number[],
  totals: Map<number, number>,
  voted: Map<number, number>,
): number {
  let best = 0;
  let runFirst: number | null = null;
  for (const e of eligibleEpochs) {
    if ((voted.get(e) ?? 0) === totals.get(e)) {
      runFirst ??= e;
      best = Math.max(best, e - runFirst + 1);
    } else {
      runFirst = null;
    }
  }
  return best;
}

async function all<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return res.results ?? [];
}

export async function awardBadges(opts: { db: D1Database; cfg: NetworkConfig; now: number }): Promise<BadgeRunResult> {
  const { db, cfg, now } = opts;
  const currentEpoch = epochFromUnix(Math.floor(now / 1000), cfg);
  const anchorSec = cfg.epochAnchor.unixSeconds;
  const anchorEpoch = cfg.epochAnchor.epoch;
  const desired: BadgeAward[] = [];
  const award = (subjectType: BadgeSubjectType, subjectId: string, badgeId: string, tier = 0) => {
    desired.push({ subjectType, subjectId, badgeId, tier });
  };
  const awardTiered = (subjectType: BadgeSubjectType, subjectId: string, badgeId: string, n: number) => {
    const tier = tierFor(n, tiersOf(badgeId));
    if (tier > 0) award(subjectType, subjectId, badgeId, tier);
  };

  // --- On-chain: vote counts per role ---------------------------------------
  const roleCounts = await all<{ role: string; id: string; n: number; r: number }>(
    db,
    `SELECT voter_role AS role, voter_id AS id, COUNT(*) AS n,
            SUM(CASE WHEN meta_url IS NOT NULL AND meta_url != '' THEN 1 ELSE 0 END) AS r
     FROM drep_votes GROUP BY voter_role, voter_id`,
  );
  for (const row of roleCounts) {
    if (row.role === 'DRep') {
      if (row.n >= 1) award('drep', row.id, 'first-vote');
      awardTiered('drep', row.id, 'active-voice', row.n);
      awardTiered('drep', row.id, 'shows-the-work', row.r);
    } else if (row.role === 'SPO') {
      awardTiered('spo', row.id, 'pool-voice', row.n);
    } else if (row.role === 'ConstitutionalCommittee') {
      if (row.n >= 1) award('cc', row.id, 'guardian');
      if (row.r >= 10) award('cc', row.id, 'reasoned-guardian');
    }
  }

  // --- On-chain: action types voted on --------------------------------------
  const typeRows = await all<{ role: string; id: string; t: string }>(
    db,
    `SELECT v.voter_role AS role, v.voter_id AS id, g.type AS t
     FROM drep_votes v JOIN governance_actions g ON g.id = v.ga_id
     GROUP BY v.voter_role, v.voter_id, g.type`,
  );
  const typesBySubject = new Map<string, { subject: BadgeSubjectType; id: string; types: Set<string> }>();
  for (const row of typeRows) {
    const subject = ROLE_SUBJECT[row.role];
    if (!subject) continue;
    getOrCreate(typesBySubject, `${subject}:${row.id}`, () => ({ subject, id: row.id, types: new Set<string>() })).types.add(
      row.t,
    );
  }
  for (const { subject, id, types } of typesBySubject.values()) {
    if (subject === 'drep') {
      if (types.size >= 7) award('drep', id, 'full-spectrum');
      if (types.has('NewConstitution')) award('drep', id, 'constitution-voter');
      if (types.has('HardForkInitiation')) award('drep', id, 'hard-fork-voter');
      if (types.has('NoConfidence')) award('drep', id, 'steady-hand');
    } else if (subject === 'spo' && types.has('HardForkInitiation')) {
      award('spo', id, 'hard-fork-ready');
    }
  }

  // --- On-chain: lone voice (minority side of a decided action, direction-neutral)
  const lone = await all<{ id: string }>(
    db,
    `SELECT DISTINCT v.voter_id AS id
     FROM drep_votes v JOIN governance_actions g ON g.id = v.ga_id
     WHERE v.voter_role = 'DRep' AND g.status NOT IN ('active', 'pending')
       AND ((v.vote = 'Yes' AND g.drep_no_pct > 90) OR (v.vote = 'No' AND g.drep_yes_pct > 90))`,
  );
  for (const row of lone) award('drep', row.id, 'lone-voice');

  // --- On-chain: vote timing (block_time is unix seconds) --------------------
  const timing = await all<{ id: string; early: number; buzzer: number }>(
    db,
    `SELECT v.id AS id,
            MAX(CASE WHEN v.ep = g.submitted_epoch THEN 1 ELSE 0 END) AS early,
            MAX(CASE WHEN v.ep = g.expiry_epoch THEN 1 ELSE 0 END) AS buzzer
     FROM (SELECT voter_id AS id, ga_id, ${epochSql('block_time')} AS ep
           FROM drep_votes WHERE voter_role = 'DRep' AND block_time IS NOT NULL) v
     JOIN governance_actions g ON g.id = v.ga_id
     GROUP BY v.id`,
    anchorSec,
    anchorEpoch,
  );
  for (const row of timing) {
    if (row.early) award('drep', row.id, 'early-bird');
    if (row.buzzer) award('drep', row.id, 'buzzer-beater');
  }

  // --- On-chain: DRep registry badges ----------------------------------------
  const drepRows = await all<{
    drep_id: string;
    registered_epoch: number | null;
    active: number;
    name: string | null;
    bio: string | null;
    image_url: string | null;
    links: string | null;
  }>(db, 'SELECT drep_id, registered_epoch, active, name, bio, image_url, links FROM dreps');
  const genesisLimit = GENESIS_EPOCH_LIMIT[cfg.network];
  const registeredEpochs = new Map<string, number>();
  for (const d of drepRows) {
    if (d.registered_epoch != null) {
      registeredEpochs.set(d.drep_id, d.registered_epoch);
      if (d.registered_epoch < genesisLimit) award('drep', d.drep_id, 'genesis-drep');
      if (d.active === 1 && d.registered_epoch <= currentEpoch - VETERAN_EPOCHS) award('drep', d.drep_id, 'veteran');
    }
    const hasLinks = !!d.links && d.links !== '[]';
    if (d.name && d.bio && d.image_url && hasLinks) award('drep', d.drep_id, 'identified');
  }

  // --- On-chain: iron streak --------------------------------------------------
  // Eligibility mirrors getDrepParticipation: decided actions with at least one
  // DRep vote, from the DRep's registration epoch onward.
  const epochTotals = await all<{ e: number; n: number }>(
    db,
    `SELECT g.decided_epoch AS e, COUNT(*) AS n FROM governance_actions g
     WHERE g.decided_epoch IS NOT NULL
       AND EXISTS (SELECT 1 FROM drep_votes dv WHERE dv.ga_id = g.id AND dv.voter_role = 'DRep')
     GROUP BY g.decided_epoch`,
  );
  const totals = new Map(epochTotals.map((r) => [r.e, r.n]));
  const eligibleEpochs = [...totals.keys()].sort((a, b) => a - b);
  const perDrepEpoch = await all<{ id: string; e: number; n: number }>(
    db,
    `SELECT v.voter_id AS id, g.decided_epoch AS e, COUNT(*) AS n
     FROM drep_votes v JOIN governance_actions g ON g.id = v.ga_id
     WHERE v.voter_role = 'DRep' AND g.decided_epoch IS NOT NULL
     GROUP BY v.voter_id, g.decided_epoch`,
  );
  const votedByDrep = new Map<string, Map<number, number>>();
  for (const row of perDrepEpoch) {
    getOrCreate(votedByDrep, row.id, () => new Map<number, number>()).set(row.e, row.n);
  }
  for (const [drepId, voted] of votedByDrep) {
    const reg = registeredEpochs.get(drepId);
    if (reg == null) continue;
    const span = longestCoveredSpan(
      eligibleEpochs.filter((e) => e >= reg),
      totals,
      voted,
    );
    awardTiered('drep', drepId, 'iron-streak', span);
  }

  // --- Proposers (identified by the action's return address) -----------------
  const proposers = await all<{ id: string; n: number; enacted: number }>(
    db,
    `SELECT return_address AS id, COUNT(*) AS n,
            MAX(CASE WHEN status IN ('ratified', 'enacted') THEN 1 ELSE 0 END) AS enacted
     FROM governance_actions WHERE return_address IS NOT NULL AND return_address != ''
     GROUP BY return_address`,
  );
  for (const row of proposers) {
    award('proposer', row.id, 'proposer');
    if (row.n >= 5) award('proposer', row.id, 'serial-proposer');
    if (row.enacted) award('proposer', row.id, 'enacted');
  }

  // --- Forum (deleted and hidden posts never count) ---------------------------
  const postAgg = await all<{ id: string; n: number; ups: number; maxup: number }>(
    db,
    `SELECT author_id AS id, COUNT(*) AS n, COALESCE(SUM(up_count), 0) AS ups, COALESCE(MAX(up_count), 0) AS maxup
     FROM posts WHERE deleted = 0 AND hidden = 0 AND author_id != ?1
     GROUP BY author_id`,
    GOV_SYNC_AUTHOR,
  );
  for (const row of postAgg) {
    if (row.n >= 1) award('user', row.id, 'hello-governance');
    awardTiered('user', row.id, 'regular', row.n);
    awardTiered('user', row.id, 'well-said', row.ups);
    if (row.maxup >= 10) award('user', row.id, 'crowd-favorite');
  }

  const topicAgg = await all<{ id: string; n: number }>(
    db,
    `SELECT author_id AS id, COUNT(*) AS n FROM topics
     WHERE deleted = 0 AND source = 'user' GROUP BY author_id`,
  );
  for (const row of topicAgg) {
    if (row.n >= 1) award('user', row.id, 'opening-move');
  }

  const sparked = await all<{ id: string }>(
    db,
    `SELECT DISTINCT t.author_id AS id FROM topics t
     WHERE t.deleted = 0 AND t.source = 'user'
       AND (SELECT COUNT(*) FROM posts p
            WHERE p.topic_id = t.id AND p.author_id != t.author_id AND p.deleted = 0 AND p.hidden = 0) >= 5`,
  );
  for (const row of sparked) award('user', row.id, 'sparked-a-debate');

  // posts.created_at is unix milliseconds; epochs need seconds.
  const postEpochs = await all<{ id: string; ep: number }>(
    db,
    `SELECT author_id AS id, ${epochSql('created_at / 1000')} AS ep
     FROM posts WHERE deleted = 0 AND hidden = 0 AND author_id != ?3
     GROUP BY author_id, ep`,
    anchorSec,
    anchorEpoch,
    GOV_SYNC_AUTHOR,
  );
  const epochsByUser = new Map<string, number[]>();
  for (const row of postEpochs) {
    getOrCreate(epochsByUser, row.id, () => []).push(row.ep);
  }
  for (const [userId, epochs] of epochsByUser) {
    awardTiered('user', userId, 'forum-streak', longestConsecutiveRun(epochs));
  }

  const onTheRecord = await all<{ id: string; n: number }>(
    db,
    `SELECT p.author_id AS id, COUNT(DISTINCT p.topic_id) AS n
     FROM posts p JOIN governance_actions g ON g.topic_id = p.topic_id
     WHERE p.deleted = 0 AND p.hidden = 0 AND p.author_id != ?1
     GROUP BY p.author_id`,
    GOV_SYNC_AUTHOR,
  );
  for (const row of onTheRecord) awardTiered('user', row.id, 'on-the-record', row.n);

  const necromancer = await all<{ id: string }>(
    db,
    `SELECT DISTINCT p.author_id AS id FROM posts p
     WHERE p.deleted = 0 AND p.hidden = 0 AND p.author_id != ?1
       AND (SELECT MAX(p2.created_at) FROM posts p2
            WHERE p2.topic_id = p.topic_id AND p2.created_at < p.created_at AND p2.deleted = 0)
           < p.created_at - ${NECRO_DORMANT_MS}`,
    GOV_SYNC_AUTHOR,
  );
  for (const row of necromancer) award('user', row.id, 'necromancer');

  const century = await all<{ id: string }>(
    db,
    `SELECT DISTINCT p.author_id AS id FROM posts p
     JOIN topics t ON t.id = p.topic_id
     WHERE t.post_count >= 100 AND p.deleted = 0 AND p.hidden = 0 AND p.author_id != ?1`,
    GOV_SYNC_AUTHOR,
  );
  for (const row of century) award('user', row.id, 'century-thread');

  const boundary = await all<{ id: string }>(
    db,
    `SELECT DISTINCT author_id AS id FROM posts
     WHERE deleted = 0 AND hidden = 0 AND author_id != ?1
       AND ((created_at / 1000 - ?2) % ${EPOCH_LENGTH_SECONDS} <= ${BOUNDARY_WINDOW_SECONDS}
            OR (created_at / 1000 - ?2) % ${EPOCH_LENGTH_SECONDS} >= ${EPOCH_LENGTH_SECONDS - BOUNDARY_WINDOW_SECONDS})`,
    GOV_SYNC_AUTHOR,
    anchorSec,
  );
  for (const row of boundary) award('user', row.id, 'boundary-rider');

  const tripleCrown = await all<{ id: string }>(
    db,
    'SELECT id FROM users WHERE is_drep + is_spo + is_cc + is_proposer >= 3',
  );
  for (const row of tripleCrown) award('user', row.id, 'triple-crown');

  // --- Crossover (subject: the DRep identity linked to the forum account) ----
  const crossover = await all<{ id: string; ga: string; first_ms: number; bt: number | null; rat: number }>(
    db,
    `SELECT u.drep_id AS id, g.id AS ga, MIN(p.created_at) AS first_ms, v.block_time AS bt,
            MAX(CASE WHEN v.meta_url IS NOT NULL AND v.meta_url != '' THEN 1 ELSE 0 END) AS rat
     FROM posts p
     JOIN users u ON u.id = p.author_id AND u.drep_id IS NOT NULL
     JOIN governance_actions g ON g.topic_id = p.topic_id
     JOIN drep_votes v ON v.ga_id = g.id AND v.voter_id = u.drep_id AND v.voter_role = 'DRep'
     WHERE p.deleted = 0 AND p.hidden = 0
     GROUP BY u.drep_id, g.id, v.block_time`,
  );
  const crossByDrep = new Map<string, { actions: number; rationale: number; deliberated: number }>();
  for (const row of crossover) {
    const c = getOrCreate(crossByDrep, row.id, () => ({ actions: 0, rationale: 0, deliberated: 0 }));
    c.actions++;
    if (row.rat) c.rationale++;
    if (row.bt != null && row.first_ms < row.bt * 1000) c.deliberated++;
  }
  for (const [drepId, c] of crossByDrep) {
    awardTiered('drep', drepId, 'says-and-does', c.actions);
    if (c.rationale >= 10) award('drep', drepId, 'open-book');
    if (c.deliberated >= 10) award('drep', drepId, 'deliberator');
  }

  // --- Diff against existing awards and write only changes -------------------
  const existing = await getAllAwards(db);
  const existingTier = new Map(existing.map((a) => [`${a.subjectType}:${a.subjectId}:${a.badgeId}`, a.tier]));

  // Collector closes over the combined state: every visible forum badge earned.
  const forumBadgeIds = BADGES.filter((b) => b.category === 'forum' && !b.hidden).map((b) => b.id);
  const forumEarned = new Map<string, Set<string>>();
  const noteForum = (subjectType: BadgeSubjectType, subjectId: string, badgeId: string) => {
    if (subjectType !== 'user' || !forumBadgeIds.includes(badgeId)) return;
    getOrCreate(forumEarned, subjectId, () => new Set<string>()).add(badgeId);
  };
  for (const a of existing) noteForum(a.subjectType, a.subjectId, a.badgeId);
  for (const a of desired) noteForum(a.subjectType, a.subjectId, a.badgeId);
  for (const [userId, earned] of forumEarned) {
    if (earned.size === forumBadgeIds.length) award('user', userId, 'collector');
  }

  const changes = desired.filter((a) => {
    const cur = existingTier.get(`${a.subjectType}:${a.subjectId}:${a.badgeId}`);
    return cur === undefined || a.tier > cur;
  });
  const written = await applyAwards(db, changes, now);
  return { desired: desired.length, written };
}
