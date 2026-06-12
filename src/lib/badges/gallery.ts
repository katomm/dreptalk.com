/// <reference types="@cloudflare/workers-types" />
// View-model for badge galleries: combines a DRep's on-chain awards with the
// linked forum account's awards. The full gallery additionally computes live
// progress counters at render time; the profile showcase loads awards only
// (awards themselves are written exclusively by the hourly engine).

import { BADGES, type Badge, badgeImagePath, badgeLockedImagePath } from '../../../config/badges.js';
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

async function loadAwardsMap(
  db: D1Database,
  drepId: string,
  userId: string | null,
): Promise<Map<string, BadgeAwardRow>> {
  const [drepAwards, userAwards] = await Promise.all([
    getSubjectAwards(db, 'drep', drepId),
    userId ? getSubjectAwards(db, 'user', userId) : Promise.resolve([] as BadgeAwardRow[]),
  ]);
  return new Map([...drepAwards, ...userAwards].map((a) => [a.badgeId, a]));
}

/**
 * Earned badges only, newest first. The cheap path for the profile showcase:
 * no live counters, just the award rows.
 */
export async function loadEarnedBadges(
  db: D1Database,
  drepId: string,
  userId: string | null,
): Promise<BadgeTileModel[]> {
  const awards = await loadAwardsMap(db, drepId, userId);
  const earned: BadgeTileModel[] = [];
  for (const badge of BADGES) {
    const award = awards.get(badge.id);
    if (award) earned.push(earnedTile(badge, award, null));
  }
  earned.sort((a, b) => (b.awardedAt ?? 0) - (a.awardedAt ?? 0));
  return earned;
}

export async function buildDrepBadgeGallery(
  db: D1Database,
  drepId: string,
  userId: string | null,
): Promise<DrepBadgeGallery> {
  const [awards, counters] = await Promise.all([loadAwardsMap(db, drepId, userId), loadBadgeCounters(db, drepId, userId)]);

  const earned: BadgeTileModel[] = [];
  const inProgress: BadgeTileModel[] = [];
  let hiddenLockedCount = 0;
  for (const badge of BADGES) {
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
