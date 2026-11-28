// Colors of the concentration bar and the quarter chart, by segment position.
// The folded rest is always muted, so an address keeps its color in both.
const PALETTE = ['var(--accent)', 'var(--gov-parameter)', 'var(--gov-committee)', 'var(--gov-hardfork)', 'var(--gov-constitution)', 'var(--c-cc)'];
export const OTHER_COLOR = 'color-mix(in srgb, var(--muted) 45%, var(--surface))';

export function segmentColor(id: string, index: number): string {
  return id === 'other' ? OTHER_COLOR : PALETTE[index % PALETTE.length];
}
