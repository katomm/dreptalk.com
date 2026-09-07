// Escaping and geometry shared by the chart renderers. Everything here is a
// pure string builder: no DOM, so it runs at build time inside the remark
// transform and in node tests.
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type Format = 'M' | 'B' | '%' | 'int';

export function fmt(v: number, f: Format): string {
  if (f === '%') return `${v.toFixed(1)}%`;
  if (f === 'M') return `${Math.round(v).toLocaleString('en-US')}M`;
  if (f === 'B') return `${v.toFixed(v >= 10 ? 1 : 2)}B`;
  return Math.round(v).toLocaleString('en-US');
}

export interface Frame {
  W: number; H: number; x0: number; x1: number; y0: number; y1: number;
  y: (v: number) => number;
}

/** Plot frame with horizontal grid lines and labelled y ticks. */
export function frame(W: number, H: number, pad: { l: number; r: number; t: number; b: number }, yMin: number, yMax: number, ticks: number[], f: Format): { fr: Frame; svg: string } {
  const x0 = pad.l, x1 = W - pad.r, y0 = H - pad.b, y1 = pad.t;
  const y = (v: number) => y0 - ((v - yMin) / (yMax - yMin)) * (y0 - y1);
  const grid = ticks
    .map((t) => `<line class="rv-grid" x1="${x0}" x2="${x1}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text x="${x0 - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(t, f))}</text>`)
    .join('');
  return { fr: { W, H, x0, x1, y0, y1, y }, svg: `${grid}<line class="rv-axis" x1="${x0}" x2="${x1}" y1="${y0}" y2="${y0}"/>` };
}

/** A positive span even for flat or all-zero series, so no renderer divides by zero. */
export function span(min: number, max: number): { min: number; max: number } {
  return max > min ? { min, max } : { min, max: min + 1 };
}

export function ticksFor(min: number, max: number, count = 4): number[] {
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + i * step);
}

export function svgOpen(W: number, H: number, label: string): string {
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" class="rv-svg">`;
}

export function marker(cx: number, cy: number, tone: string, title: string): string {
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" class="rv-dot rv-${tone}"><title>${esc(title)}</title></circle>`;
}
