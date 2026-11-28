// Geometry of the DRepTalk burst mark in its 72x72 viewBox, shared by the
// LogoMark component and the pull-to-refresh loader (which builds its SVG as a
// string in the browser). Matches public/logo.svg. Nodes and spokes run
// clockwise from the top, so the loader can light them in order.

export interface Spoke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Dot {
  cx: number;
  cy: number;
  r: number;
}

export const BURST_SPOKES: readonly Spoke[] = [
  { x1: 36, y1: 27.5, x2: 36, y2: 19.5 },
  { x1: 42, y1: 30, x2: 47.7, y2: 24.3 },
  { x1: 44.5, y1: 36, x2: 52.5, y2: 36 },
  { x1: 42, y1: 42, x2: 47.7, y2: 47.7 },
  { x1: 36, y1: 44.5, x2: 36, y2: 52.5 },
  { x1: 30, y1: 42, x2: 24.3, y2: 47.7 },
  { x1: 27.5, y1: 36, x2: 19.5, y2: 36 },
  { x1: 30, y1: 30, x2: 24.3, y2: 24.3 },
];

export const BURST_NODES: readonly Dot[] = [
  { cx: 36, cy: 15, r: 4 },
  { cx: 50.85, cy: 21.15, r: 4 },
  { cx: 57, cy: 36, r: 4 },
  { cx: 50.85, cy: 50.85, r: 4 },
  { cx: 36, cy: 57, r: 4 },
  { cx: 21.15, cy: 50.85, r: 4 },
  { cx: 15, cy: 36, r: 4 },
  { cx: 21.15, cy: 21.15, r: 4 },
];

export const BURST_RING: readonly Dot[] = [
  { cx: 47.1, cy: 9.2, r: 2 },
  { cx: 62.8, cy: 24.9, r: 2 },
  { cx: 62.8, cy: 47.1, r: 2 },
  { cx: 47.1, cy: 62.8, r: 2 },
  { cx: 24.9, cy: 62.8, r: 2 },
  { cx: 9.2, cy: 47.1, r: 2 },
  { cx: 9.2, cy: 24.9, r: 2 },
  { cx: 24.9, cy: 9.2, r: 2 },
];

export const BURST_CENTER: Dot = { cx: 36, cy: 36, r: 7 };

/** Brand gradient stops and vector in the mark's viewBox, as in public/logo.svg. */
export const BRAND_GRAD_STOPS = ['#8b5cf6', '#3b82f6', '#2dd4bf'] as const;
export const BRAND_GRAD_VECTOR = { x1: 8, y1: 56, x2: 66, y2: 16 } as const;

/**
 * The loader variant as an SVG string: spokes, nodes and center without the
 * outer ring (like the favicon, it reads better at small sizes). Styled by the
 * `.burst-loading` rules in global.css, which light the nodes in turn (each
 * node carries its index as --i for the stagger).
 */
export function burstLoaderSvg(size: number): string {
  const spokes = BURST_SPOKES.map((s) => `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}"/>`).join('');
  const nodes = BURST_NODES.map((n, i) => `<circle class="burst-node" style="--i:${i}" cx="${n.cx}" cy="${n.cy}" r="${n.r}"/>`).join('');
  const c = BURST_CENTER;
  return (
    `<svg class="burst-loading" width="${size}" height="${size}" viewBox="0 0 72 72" fill="currentColor" aria-hidden="true">` +
    `<g stroke="currentColor" stroke-width="2.4" stroke-linecap="round">${spokes}</g>` +
    `${nodes}<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}"/></svg>`
  );
}
