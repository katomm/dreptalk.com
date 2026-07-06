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

  it('keeps active slots inside the scene box (0..1)', () => {
    // Active pills must stay in the box; ghosts intentionally sit beyond it (the
    // scene lets them overflow) and so are excluded from this bound.
    for (const s of heroRingSlots(10, 8).filter((s) => s.kind === 'active')) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(1);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(1);
    }
  });

  it('places ghosts on a wider ring than the active pills', () => {
    for (const s of heroRingSlots(10, 8).filter((s) => s.kind === 'ghost')) {
      const d = Math.hypot(s.x - 0.5, s.y - 0.5);
      // Beyond the active ring's largest radius, so ghosts form a distinct outer
      // halo; still within a sane bound so they do not fly off the page.
      expect(d).toBeGreaterThan(HERO_RING_RADII.active.rx);
      expect(d).toBeLessThan(0.75);
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

  it('exposes ring radii with ghosts outside the active ring', () => {
    expect(HERO_RING_RADII.active.rx).toBeGreaterThan(HERO_RING_RADII.active.ry);
    expect(HERO_RING_RADII.ghost.rx).toBeGreaterThan(HERO_RING_RADII.active.rx);
    expect(HERO_RING_RADII.ghost.ry).toBeGreaterThan(HERO_RING_RADII.active.ry);
  });
});
