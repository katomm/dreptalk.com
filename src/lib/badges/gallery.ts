/// <reference types="@cloudflare/workers-types" />
// View-model for badge galleries: combines a DRep's on-chain awards with the
// linked forum account's awards. The full gallery additionally computes live
// progress counters at render time; the profile showcase loads awards only
// (awards themselves are written exclusively by the hourly engine).

import { BADGES, CATEGORIES_FOR_ROLE, type Badge, type BadgeCategory, badgeImagePath, badgeLockedImagePath } from '../../../config/badges.js';
import {
  type BadgeAwardRow,
  type BadgeCounters,
  getSubjectAwards,
  loadBadgeCounters,
} from '../db/badgeAwards.js';

export interface BadgeProgress {
  current: number;
  goal: number;
}

export interface BadgeTileModel {
  badge: Badge;
  earned: boolean;
  /** Awarded tier (0 = untiered) when earned. */
  tier: number;
  awardedAt: number | null;
  image: string;
  /** Toward the next tier when earned, toward the first award otherwise. */
  progress: BadgeProgress | null;
}

export interface DrepBadgeGallery {
  earned: BadgeTileModel[];
  /** Visible badges not yet earned (locked artwork, progress where known). */
  inProgress: BadgeTileModel[];
  /** Hidden badges not yet earned; rendered as anonymous mystery cards. */
  hiddenLockedCount: number;
}

export interface BadgeSubject {
  /** Profile role; also the awards subject_type ('drep' | 'spo'). */
  role: 'drep' | 'spo';
  /** drepId or poolId. */
  id: string;
  /** Linked forum account, source of forum/crossover awards. */
  userId: string | null;
}

/** Badges this role can earn, as a fast lookup set. */
function categorySet(role: 'drep' | 'spo'): Set<BadgeCategory> {
  return new Set(CATEGORIES_FOR_ROLE[role]);
}

const CURRENT: Record<string, (c: BadgeCounters) => number> = {
  'first-vote': (c) => c.votes,
  'active-voice': (c) => c.votes,
  'shows-the-work': (c) => c.rationale,
  'full-spectrum': (c) => c.types,
  'says-and-does': (c) => c.cross,
  'open-book': (c) => c.crossRationale,
  deliberator: (c) => c.crossDeliberated,
  'hello-governance': (c) => c.posts,
  regular: (c) => c.posts,
  'well-said': (c) => c.ups,
  'crowd-favorite': (c) => c.maxUp,
  'opening-move': (c) => c.topics,
  'on-the-record': (c) => c.govTopics,
};

/** Next milestone for a badge: the following tier when earned, the first award otherwise. */
function goalFor(badge: Badge, earnedTier: number): number | null {
  if (badge.tiers) return earnedTier < 3 ? badge.tiers[earnedTier] : null;
  if (earnedTier === 0 && badge.goal && badge.goal > 1) return badge.goal;
  return null;
}

function progressFor(badge: Badge, earnedTier: number, counters: BadgeCounters): BadgeProgress | null {
  const current = CURRENT[badge.id]?.(counters);
  const goal = goalFor(badge, earnedTier);
  if (current === undefined || goal === null) return null;
  return { current: Math.min(current, goal), goal };
}

function earnedTile(badge: Badge, award: BadgeAwardRow, progress: BadgeProgress | null): BadgeTileModel {
  return {
    badge,
    earned: true,
    tier: award.tier,
    awardedAt: award.upgradedAt ?? award.awardedAt,
    image: badgeImagePath(badge.id, award.tier),
    progress,
  };
}

async function loadAwardsMap(db: D1Database, subject: BadgeSubject): Promise<Map<string, BadgeAwardRow>> {
  const [subjectAwards, userAwards] = await Promise.all([
    getSubjectAwards(db, subject.role, subject.id),
    subject.userId ? getSubjectAwards(db, 'user', subject.userId) : Promise.resolve([] as BadgeAwardRow[]),
  ]);
  return new Map([...subjectAwards, ...userAwards].map((a) => [a.badgeId, a]));
}

/**
 * Earned badges only, newest first. Filtered to the categories this role can
 * earn so a profile never shows another role's badges.
 */
export async function loadEarnedBadges(db: D1Database, subject: BadgeSubject): Promise<BadgeTileModel[]> {
  const awards = await loadAwardsMap(db, subject);
  const allowed = categorySet(subject.role);
  const earned: BadgeTileModel[] = [];
  for (const badge of BADGES) {
    if (!allowed.has(badge.category)) continue;
    const award = awards.get(badge.id);
    if (award) earned.push(earnedTile(badge, award, null));
  }
  earned.sort((a, b) => (b.awardedAt ?? 0) - (a.awardedAt ?? 0));
  return earned;
}

export async function buildBadgeGallery(db: D1Database, subject: BadgeSubject): Promise<DrepBadgeGallery> {
  // loadBadgeCounters is hardwired to voter_role = 'DRep', so this is only safe
  // while buildBadgeGallery is called with role: 'drep'. A future SPO /badges
  // page must not reuse this function with role: 'spo' until the counters
  // query is made role-aware; the SPO profile currently uses loadEarnedBadges,
  // which needs no counters.
  const [awards, counters] = await Promise.all([loadAwardsMap(db, subject), loadBadgeCounters(db, subject.id, subject.userId)]);
  const allowed = categorySet(subject.role);

  const earned: BadgeTileModel[] = [];
  const inProgress: BadgeTileModel[] = [];
  let hiddenLockedCount = 0;
  for (const badge of BADGES) {
    if (!allowed.has(badge.category)) continue;
    const award = awards.get(badge.id);
    if (award) {
      earned.push(earnedTile(badge, award, progressFor(badge, award.tier, counters)));
    } else if (badge.hidden) {
      hiddenLockedCount++;
    } else {
      inProgress.push({
        badge,
        earned: false,
        tier: 0,
        awardedAt: null,
        image: badgeLockedImagePath(badge),
        progress: progressFor(badge, 0, counters),
      });
    }
  }

  earned.sort((a, b) => (b.awardedAt ?? 0) - (a.awardedAt ?? 0));
  // Closest to unlocking first; badges without a live counter close the list.
  const ratio = (t: BadgeTileModel) => (t.progress ? t.progress.current / t.progress.goal : -1);
  inProgress.sort((a, b) => ratio(b) - ratio(a));

  return { earned, inProgress, hiddenLockedCount };
}

/** The profile showcase: rarest earned badges first (fewest holders), then newest. */
export function pickShowcase(
  earned: BadgeTileModel[],
  holderCounts: Map<string, number>,
  n = 3,
): BadgeTileModel[] {
  return [...earned]
    .sort(
      (a, b) =>
        (holderCounts.get(a.badge.id) ?? 0) - (holderCounts.get(b.badge.id) ?? 0) ||
        (b.awardedAt ?? 0) - (a.awardedAt ?? 0),
    )
    .slice(0, n);
}
