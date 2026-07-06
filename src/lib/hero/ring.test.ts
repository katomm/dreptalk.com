import { describe, expect, it } from 'vitest';
import { heroRingSlots, HERO_RING_RADII } from './ring';

describe('heroRingSlots', () => {
  it('returns active slots first, then ghosts, each 0-indexed', () => {
    const slots = heroRingSlots(10, 6);
    expect(slots).toHaveLength(16);
    expect(slots.slice(0, 10).every((s) => s.kind === 'active')).toBe(true);
    expect(slots.slice(10).every((s) => s.kind === 'ghost')).toBe(true);
    expect(slots[0].index).toBe(0);
    expect(slots[9].index).toBe(9);
    // Ghost group re-indexes from 0 so its per-index reveal delay is independent.
    expect(slots[10].index).toBe(0);
  });

  it('keeps every coordinate inside the scene box (0..1)', () => {
    for (const s of heroRingSlots(10, 8)) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(1);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(1);
    }
  });

  it('never places a slot over the centered card', () => {
    // Every slot sits well out from center, so none overlaps the card at 0.5,0.5.
    for (const s of heroRingSlots(10, 8)) {
      const d = Math.hypot(s.x - 0.5, s.y - 0.5);
      expect(d).toBeGreaterThan(0.3);
    }
  });

  it('is deterministic', () => {
    expect(heroRingSlots(8, 4)).toEqual(heroRingSlots(8, 4));
  });

  it('handles a reduced active count with no ghosts', () => {
    const slots = heroRingSlots(8, 0);
    expect(slots).toHaveLength(8);
    expect(slots.every((s) => s.kind === 'active')).toBe(true);
  });

  it('exposes ring radii that fit inside the box', () => {
    expect(HERO_RING_RADII.active.rx).toBeGreaterThan(HERO_RING_RADII.active.ry);
    expect(0.5 + HERO_RING_RADII.ghost.rx).toBeLessThanOrEqual(1);
    expect(0.5 + HERO_RING_RADII.ghost.ry).toBeLessThanOrEqual(1);
  });
});
