import { esc, svgOpen } from './svg.js';
import type { MatrixSpec } from './schema.js';

/**
 * Ballots of a few named voters on a few actions, one cell each. Equal cells
 * show decisions, not voting weights, which the caption has to say. Every
 * state carries a symbol as well as a colour, so the grid reads without colour.
 */
const CELL = { Yes: ['s1', '✓'], No: ['s2', '✕'], Abstain: ['s3', '–'], 'did not vote': ['none', '·'] } as const;

export function renderMatrix(s: MatrixSpec): string {
  const W = 700, LABELS = 250, rowH = 30, headH = 34, top = 6;
  const cols = s.columns.length;
  const cw = Math.min(90, (W - LABELS - 10) / cols);
  const H = top + headH + s.rows.length * rowH + 8;
  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  s.columns.forEach((c, j) => {
    const cx = LABELS + j * cw + cw / 2;
    // A long voter name wraps onto two lines at its middle space, so neighbouring
    // headers never run into each other.
    const words = c.split(' ');
    const lines = c.length > 12 && words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [c];
    lines.forEach((ln, k) => { out += `<text class="rv-lbl" x="${cx.toFixed(1)}" y="${top + 10 + k * 13 + (lines.length === 1 ? 10 : 0)}" text-anchor="middle">${esc(ln)}</text>`; });
  });
  s.rows.forEach((r, i) => {
    const y = top + headH + i * rowH;
    out += `<text x="${LABELS - 12}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(r.label)}</text>`;
    r.cells.forEach((cell, j) => {
      const [tone, sym] = CELL[cell];
      const x = LABELS + j * cw + 3;
      out += `<rect class="rv-cell rv-${tone}" x="${x.toFixed(1)}" y="${y + 3}" width="${(cw - 6).toFixed(1)}" height="${rowH - 6}" rx="4"><title>${esc(`${s.columns[j]} on ${r.label}: ${cell}`)}</title></rect>`;
      out += `<text class="rv-sym rv-${tone}" x="${(x + (cw - 6) / 2).toFixed(1)}" y="${y + rowH / 2 + 5}" text-anchor="middle">${sym}</text>`;
    });
  });
  return out + '</svg>';
}
