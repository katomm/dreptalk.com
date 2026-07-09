// Gallery view-model tests: awards come from the engine, progress is computed
// live, hidden badges collapse into an anonymous count.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HIDDEN_BADGES } from '../../../config/badges.js';
import { resolveNetwork } from '../config/network.js';
import { awardBadges } from './engine.js';
import { buildBadgeGallery, pickShowcase, type BadgeTileModel } from './gallery.js';

const cfg = resolveNetwork('mainnet');
const NOW = Date.now();

describe('badge gallery', () => {
  it('splits earned, in-progress with live counters, and hidden badges', async () => {
    for (let i = 0; i < 3; i++) {
      await env.DB
        .prepare(
          `INSERT INTO governance_actions (id, type, anchor_status, status, created_at, last_synced_at)
           VALUES (?, 'InfoAction', 'no-anchor', 'active', ?, ?)`,
        )
        .bind(`ga-${i}`, NOW, NOW)
        .run();
      await env.DB
        .prepare(
          `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at)
           VALUES (?, 'DRep', 'drep1', NULL, 'Yes', ?, NULL, ?)`,
        )
        .bind(`ga-${i}`, i < 2 ? `https://r/${i}` : null, NOW)
        .run();
    }
    await awardBadges({ db: env.DB, cfg, now: NOW });

    const gallery = await buildBadgeGallery(env.DB, { role: 'drep', id: 'drep1', userId: null });
    expect(gallery.earned.map((t) => t.badge.id)).toContain('first-vote');
    expect(gallery.hiddenLockedCount).toBe(HIDDEN_BADGES.length);

    const activeVoice = gallery.inProgress.find((t) => t.badge.id === 'active-voice');
    expect(activeVoice?.progress).toEqual({ current: 3, goal: 10 });
    expect(activeVoice?.image).toBe('/badges/active-voice-locked.svg');
    const showsTheWork = gallery.inProgress.find((t) => t.badge.id === 'shows-the-work');
    expect(showsTheWork?.progress).toEqual({ current: 2, goal: 10 });

    // Closest-to-unlocking sorts first; badges without a counter trail.
    const ratios = gallery.inProgress.map((t) => (t.progress ? t.progress.current / t.progress.goal : -1));
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);
  });

  it('a DRep gallery never lists SPO, CC, or proposer badges', async () => {
    await env.DB
      .prepare(
        `INSERT INTO governance_actions (id, type, anchor_status, status, created_at, last_synced_at)
         VALUES ('ga-x', 'InfoAction', 'no-anchor', 'active', ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, block_time, synced_at)
         VALUES ('ga-x', 'DRep', 'drep1', NULL, 'Yes', NULL, NULL, ?)`,
      )
      .bind(NOW)
      .run();
    await awardBadges({ db: env.DB, cfg, now: NOW });

    const gallery = await buildBadgeGallery(env.DB, { role: 'drep', id: 'drep1', userId: null });
    const ids = [...gallery.earned, ...gallery.inProgress].map((t) => t.badge.id);
    expect(ids).not.toContain('pool-voice');
    expect(ids).not.toContain('hard-fork-ready');
    expect(ids).not.toContain('guardian');
    expect(ids).not.toContain('proposer');
  });

  it('ranks the showcase by rarity, then recency', () => {
    const tile = (id: string, awardedAt: number): BadgeTileModel => ({
      badge: { id, name: id, description: '', category: 'drep' },
      earned: true,
      tier: 0,
      awardedAt,
      image: `/badges/${id}.svg`,
      progress: null,
    });
    const earned = [tile('common', 3), tile('rare', 1), tile('mid-old', 2), tile('mid-new', 5)];
    const holders = new Map([
      ['common', 900],
      ['rare', 3],
      ['mid-old', 40],
      ['mid-new', 40],
    ]);
    expect(pickShowcase(earned, holders, 3).map((t) => t.badge.id)).toEqual(['rare', 'mid-new', 'mid-old']);
  });
});
