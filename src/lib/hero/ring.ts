// Pure geometry for the homepage hero "live voting" scene. Active voters ring the
// centered governance card on an inner ellipse, fainter ghost voters sit on an
// outer ellipse in the gaps. Returns normalized fractional coordinates (0..1,
// card center at 0.5, 0.5). No I/O and no randomness: a fixed jitter table keeps
// the layout identical across server renders, so there is no layout shift.

export type HeroSlotKind = 'active' | 'ghost';

export interface HeroSlot {
  kind: HeroSlotKind;
  /** Index within its own kind group (0-based), used for staggered reveal delays. */
  index: number;
  /** Horizontal position as a fraction of scene width (0..1). */
  x: number;
  /** Vertical position as a fraction of scene height (0..1). */
  y: number;
}

// Ellipse radii as fractions of the scene half-extent. rx > ry (wider than tall)
// so the horizontal voters clear the wide card left and right. Ghosts sit further
// out and are edge-faded by a CSS mask.
const ACTIVE_RX = 0.44;
const ACTIVE_RY = 0.4;
const GHOST_RX = 0.49;
const GHOST_RY = 0.45;

export const HERO_RING_RADII = {
  active: { rx: ACTIVE_RX, ry: ACTIVE_RY },
  ghost: { rx: GHOST_RX, ry: GHOST_RY },
};

// Deterministic per-slot angular jitter (radians) so the ring looks organic
// rather than mechanically even. Small, hand-picked values, the index wraps.
const JITTER = [0.0, 0.12, -0.1, 0.08, -0.14, 0.06, -0.08, 0.1, -0.05, 0.13, -0.11, 0.07];

function place(count: number, rx: number, ry: number, angleOffset: number, kind: HeroSlotKind): HeroSlot[] {
  const slots: HeroSlot[] = [];
  for (let i = 0; i < count; i++) {
    // Even spacing from the top (-90deg) plus a fixed jitter plus a group offset.
    const base = -Math.PI / 2 + (i / count) * Math.PI * 2;
    const angle = base + angleOffset + JITTER[i % JITTER.length];
    slots.push({
      kind,
      index: i,
      x: 0.5 + rx * Math.cos(angle),
      y: 0.5 + ry * Math.sin(angle),
    });
  }
  return slots;
}

/**
 * Ring positions for the hero scene: active voters on the inner ellipse, ghosts
 * on the outer ellipse offset into the gaps. Active slots come first, ghosts
 * second, each group is independently 0-indexed via `index`.
 */
export function heroRingSlots(activeCount: number, ghostCount: number): HeroSlot[] {
  const active = place(activeCount, ACTIVE_RX, ACTIVE_RY, 0, 'active');
  // Offset ghosts by half a step so they interleave with the active voters.
  const ghostOffset = ghostCount > 0 ? Math.PI / ghostCount : 0;
  const ghost = place(ghostCount, GHOST_RX, GHOST_RY, ghostOffset, 'ghost');
  return [...active, ...ghost];
}
