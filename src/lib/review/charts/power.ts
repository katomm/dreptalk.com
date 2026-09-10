import { esc, fmt, span, svgOpen, type Format } from './svg.js';
import type { PowerSpec } from './schema.js';

/**
 * What actually voted on a proposal, measured in delegated ada rather than
 * ballots. The bar cannot be read as the reported share, because abstaining
 * power is excluded from that share, so each row prints its own share on the
 * right and the bar answers a different question: how much power engaged.
 */
export function renderPower(s: PowerSpec): string {
  const W = 700, rowH = 44, top = 14;
  const H = top + s.rows.length * rowH + 26;
  const f = s.format as Format;
  const totals = s.rows.map((r) => r.yes + r.no + r.abstain);
  const { max } = span(0, Math.max(...totals) * 1.02);
  const x0 = 190, x1 = W - 74;
  const w = (v: number) => (v / max) * (x1 - x0);

  let out = svgOpen(W, H, `${s.title}${s.subtitle ? `. ${s.subtitle}` : ''}`);
  s.rows.forEach((r, i) => {
    const y = top + i * rowH + 8;
    out += `<text x="${(x0 - 12).toFixed(1)}" y="${y + 16}" text-anchor="end">${esc(r.label)}</text>`;
    let cursor = x0;
    for (const [v, t, name] of [[r.yes, 's1', 'Yes'], [r.no, 's2', 'No'], [r.abstain, 's3', 'Abstain']] as const) {
      if (v <= 0) continue;
      out += `<rect class="rv-bar rv-${t}" x="${cursor.toFixed(1)}" y="${y}" width="${Math.max(2, w(v)).toFixed(1)}" height="23" rx="2"><title>${esc(`${r.label}, ${name}: ${fmt(v, f)}`)}</title></rect>`;
      cursor += w(v);
    }
    out += `<text class="rv-lbl" x="${(x1 + 8).toFixed(1)}" y="${y + 16}">${esc(`${r.share.toFixed(1)}%`)}</text>`;
  });
  if (s.threshold != null) out += `<text class="rv-muted" x="${(x1 + 8).toFixed(1)}" y="${H - 8}">${esc(`bar ${s.threshold}%`)}</text>`;
  return out + '</svg>';
}
