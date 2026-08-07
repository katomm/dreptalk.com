// HTML-string builders for the OG cards. workers-og (satori) renders these to a
// 1200x630 PNG. Constraints baked in: every multi-child container sets an
// explicit display:flex (satori needs it), colours are literal hex, and images
// are passed as data URLs. compact() strips inter-tag whitespace because satori
// otherwise treats the newlines/indentation as empty flex children and skews
// justify-content (it pushed the header logo off the left edge).

import { BRAND_ACCENT, CARD_BG, INK, MUTED, OG_HEIGHT, SUBTLE, TALLY, TRACK, tint } from './theme.js';
import { fmtPctFine } from '../governance/view.js';
import type {
  CommitteeCardModel,
  DiscussionCardModel,
  DrepCardModel,
  DrepStat,
  GovCardModel,
  MoverRow,
  MoversCardModel,
  TreasuryCardModel,
  VoteCardModel,
} from './model.js';

// satori-html renders text nodes verbatim (it does not decode HTML entities), so
// escaping &, " or ' would show the entity literally. We only neutralize the one
// character that could start a tag; entity decoding happens upstream
// (excerptFromHtml), so the text arrives as real glyphs.
function esc(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Collapse whitespace that sits purely between tags. Text content (which always
// has non-space characters) is never matched, so labels keep their spaces.
function compact(html: string): string {
  return html.replace(/>\s+</g, '><').trim();
}

// The DRepTalk burst mark, painted muted grey to match the site header (where the
// "Talk" gradient is the only accent). Same geometry as LogoMark.astro, embedded
// as an SVG data URL (the proven satori image path). The gradient matches --grad.
const BRAND_MARK = `data:image/svg+xml;base64,${btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" fill="${MUTED}"><g stroke="${MUTED}" stroke-width="2.4" stroke-linecap="round"><line x1="36" y1="27.5" x2="36" y2="19.5"/><line x1="42" y1="30" x2="47.7" y2="24.3"/><line x1="44.5" y1="36" x2="52.5" y2="36"/><line x1="42" y1="42" x2="47.7" y2="47.7"/><line x1="36" y1="44.5" x2="36" y2="52.5"/><line x1="30" y1="42" x2="24.3" y2="47.7"/><line x1="27.5" y1="36" x2="19.5" y2="36"/><line x1="30" y1="30" x2="24.3" y2="24.3"/></g><circle cx="36" cy="15" r="4"/><circle cx="50.85" cy="21.15" r="4"/><circle cx="57" cy="36" r="4"/><circle cx="50.85" cy="50.85" r="4"/><circle cx="36" cy="57" r="4"/><circle cx="21.15" cy="50.85" r="4"/><circle cx="15" cy="36" r="4"/><circle cx="21.15" cy="21.15" r="4"/><circle cx="47.1" cy="9.2" r="2"/><circle cx="62.8" cy="24.9" r="2"/><circle cx="62.8" cy="47.1" r="2"/><circle cx="47.1" cy="62.8" r="2"/><circle cx="24.9" cy="62.8" r="2"/><circle cx="9.2" cy="47.1" r="2"/><circle cx="9.2" cy="24.9" r="2"/><circle cx="24.9" cy="9.2" r="2"/><circle cx="36" cy="36" r="7"/></svg>`,
)}`;

const GRAD = 'linear-gradient(120deg, #8b5cf6 0%, #3b82f6 50%, #2dd4bf 100%)';

// Brand lockup: muted burst mark + "DRep" in ink and "Talk" in the gradient
// (background-clip:text), matching the site header.
function header(rightPill: string): string {
  return `<div style="display:flex;align-items:center;justify-content:space-between;">
    <div style="display:flex;align-items:center;">
      <img src="${BRAND_MARK}" width="56" height="56" style="margin-right:14px;" />
      <div style="display:flex;font-size:32px;font-weight:700;letter-spacing:-0.3px;">
        <span style="color:${INK};">DRep</span>
        <span style="background-image:${GRAD};-webkit-background-clip:text;background-clip:text;color:transparent;">Talk</span>
      </div>
    </div>
    ${rightPill}
  </div>`;
}

function pill(text: string, color: string): string {
  return `<span style="display:flex;font-size:24px;font-weight:600;color:${color};background:${tint(color)};padding:10px 22px;border-radius:999px;text-transform:uppercase;letter-spacing:0.5px;">${esc(text)}</span>`;
}

// The shared frame for every card: white canvas, padded content column with
// the brand header on top and the card-specific body below, and a full-width
// accent bar along the bottom edge. Each builder feeds its own pill label and
// body; the accent both tints the pill and paints the bottom bar.
function cardShell(accent: string, pillText: string, body: string): string {
  return compact(`<div style="display:flex;flex-direction:column;width:1200px;height:${OG_HEIGHT}px;background:${CARD_BG};font-family:'Plus Jakarta Sans','Ada';color:${INK};">
    <div style="display:flex;flex-direction:column;justify-content:space-between;flex:1;padding:40px 48px;">
      ${header(pill(pillText, accent))}
      ${body}
    </div>
    <div style="display:flex;width:1200px;height:12px;background:${accent};"></div>
  </div>`);
}

function title(text: string, maxWidth = 1010): string {
  return `<div style="display:flex;font-size:56px;font-weight:800;line-height:1.15;letter-spacing:-1px;max-width:${maxWidth}px;">${esc(text)}</div>`;
}

// Number-led: the leading body's Yes-of-eligible share as a big figure, over a thin
// bar whose green fill is that share and whose neutral remainder is everything else
// (no, abstain and, dominant on low turnout, not-voted). The remainder is deliberately
// left unlabeled here since the card has no room to split it honestly; the detail page
// carries the full Yes / No / Not-voted breakdown.
function tallyBlock(t: { yesPct: number; role: string }): string {
  const yes = Math.min(100, Math.max(0, t.yesPct));
  const bodyLabel = t.role === 'SPO' ? 'SPOs' : t.role === 'CC' ? 'the committee' : 'DReps';
  return `<div style="display:flex;flex-direction:column;">
    <div style="display:flex;align-items:baseline;margin-bottom:14px;">
      <span style="display:flex;font-size:64px;font-weight:800;color:${INK};">${fmtPctFine(yes)}</span>
      <span style="display:flex;font-size:32px;font-weight:500;color:${MUTED};margin-left:14px;">${bodyLabel} yes of eligible</span>
    </div>
    <div style="display:flex;width:1010px;height:20px;border-radius:10px;overflow:hidden;background:${TRACK};">
      <div style="display:flex;width:${yes}%;height:20px;background:${TALLY.yes};"></div>
    </div>
  </div>`;
}

function votingOpen(): string {
  return `<div style="display:flex;">
    <span style="display:flex;font-size:24px;font-weight:700;color:${BRAND_ACCENT};background:${tint(BRAND_ACCENT)};padding:8px 18px;border-radius:8px;">Voting open</span>
  </div>`;
}

export function govCardHtml(m: GovCardModel): string {
  const meta = m.meta
    ? `<span style="font-size:24px;font-weight:500;color:${MUTED};margin-left:16px;">${esc(m.meta)}</span>`
    : '';
  const subtitle = m.subtitle
    ? `<div style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-top:16px;line-height:1.35;max-width:1010px;">${esc(m.subtitle)}</div>`
    : '';
  const body = `<div style="display:flex;flex-direction:column;">${title(m.title)}${subtitle}</div>
    <div style="display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;margin-bottom:14px;">
        <span style="display:flex;font-size:24px;font-weight:700;color:${m.status.color};background:${m.status.tint};padding:6px 16px;border-radius:8px;">${esc(m.status.label)}</span>
        ${meta}
      </div>
      ${m.tally ? tallyBlock(m.tally) : votingOpen()}
    </div>`;
  return cardShell(m.accent, m.typeLabel, body);
}

// A joining/leaving count chip for the committee summary: a coloured +/- box and
// "<label> · <count>". Rendered only when the count is non-zero.
function committeeChip(kind: 'add' | 'remove', count: number): string {
  const color = kind === 'add' ? TALLY.yes : TALLY.no;
  const sign = kind === 'add' ? '+' : '-';
  const label = kind === 'add' ? 'Joining' : 'Leaving';
  return `<div style="display:flex;align-items:center;">
      <span style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px;background:${color};color:#ffffff;font-size:28px;font-weight:800;margin-right:12px;">${sign}</span>
      <span style="display:flex;font-size:28px;font-weight:700;color:${INK};">${label} · ${count}</span>
    </div>`;
}

// One Yes-of-eligible bar for a voting body (DReps / SPOs), compact enough that
// both bodies stack under the summary within the card height.
function committeeBar(label: string, yesPct: number): string {
  const yes = Math.min(100, Math.max(0, yesPct));
  return `<div style="display:flex;flex-direction:column;margin-top:20px;">
      <div style="display:flex;align-items:baseline;margin-bottom:8px;">
        <span style="display:flex;font-size:40px;font-weight:800;color:${INK};">${fmtPctFine(yes)}</span>
        <span style="display:flex;font-size:26px;font-weight:500;color:${MUTED};margin-left:12px;">${esc(label)} yes of eligible</span>
      </div>
      <div style="display:flex;width:1010px;height:16px;border-radius:8px;overflow:hidden;background:${TRACK};">
        <div style="display:flex;width:${yes}%;height:16px;background:${TALLY.yes};"></div>
      </div>
    </div>`;
}

// Committee membership change card: a joining/leaving count summary over the DRep
// and SPO Yes-of-eligible bars (the two bodies that vote on a committee action).
export function committeeCardHtml(m: CommitteeCardModel): string {
  const meta = m.meta
    ? `<span style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-left:16px;">${esc(m.meta)}</span>`
    : '';
  const statusRow = `<div style="display:flex;align-items:center;margin-bottom:26px;">
      <span style="display:flex;font-size:24px;font-weight:700;color:${m.status.color};background:${m.status.tint};padding:6px 16px;border-radius:8px;">${esc(m.status.label)}</span>
      ${meta}
    </div>`;
  const chips = [
    m.addedCount > 0 ? committeeChip('add', m.addedCount) : '',
    m.removedCount > 0 ? committeeChip('remove', m.removedCount) : '',
  ].filter(Boolean);
  // Right-aligned, with a fixed spacer between the two chips (satori's flex `gap`
  // is unreliable, and a trailing margin would push the last chip off the edge).
  const summary = `<div style="display:flex;justify-content:flex-end;align-items:center;">${chips.join('<span style="display:flex;width:36px;"></span>')}</div>`;
  const bars = m.bars.map((b) => committeeBar(b.label, b.yesPct)).join('');
  const body = `<div style="display:flex;flex-direction:column;">${title(m.title)}</div>
    <div style="display:flex;flex-direction:column;">
      ${statusRow}
      ${summary}
      ${bars}
    </div>`;
  return cardShell(m.accent, m.typeLabel, body);
}

// Thin line icons (Lucide-style) drawn here so the stat row matches the design.
// Stored as path bodies; statIcon() wraps them with the accent stroke and embeds
// the result as an SVG data URL (the proven satori image path, same as the
// avatar). One key per DrepStat.icon.
const ICON_PATHS: Record<string, string> = {
  power:
    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  votes:
    '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 14l2 2 4-4"/>',
  participation: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  epoch:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
};

function statIcon(key: string | undefined, color: string): string {
  const body = key ? ICON_PATHS[key] : undefined;
  if (!body) return '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return `<img src="data:image/svg+xml;base64,${btoa(svg)}" width="30" height="30" style="margin-right:10px;" />`;
}

function statBlock(s: DrepStat, accent: string): string {
  const label = s.label
    ? `<div style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-top:4px;">${esc(s.label)}</div>`
    : '';
  return `<div style="display:flex;flex-direction:column;margin-right:40px;">
    <div style="display:flex;align-items:center;">
      ${statIcon(s.icon, accent)}
      <div style="display:flex;font-size:40px;font-weight:800;">${esc(s.value)}</div>
    </div>
    ${label}
  </div>`;
}

export function drepCardHtml(m: DrepCardModel): string {
  const idLine = m.idShort
    ? `<div style="display:flex;font-size:24px;font-weight:500;color:${SUBTLE};margin-top:8px;">${esc(m.idShort)}</div>`
    : '';
  const bioLine = m.bio
    ? `<div style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-top:16px;line-height:1.35;">${esc(m.bio)}</div>`
    : '';
  const body = `<div style="display:flex;align-items:center;">
      <div style="display:flex;flex-direction:column;flex:1;padding-right:32px;">
        <div style="display:flex;font-size:56px;font-weight:800;line-height:1.15;letter-spacing:-1px;">${esc(m.name)}</div>
        ${idLine}
        ${bioLine}
      </div>
      <img src="${m.avatarDataUrl}" width="160" height="160" style="border-radius:999px;" />
    </div>
    <div style="display:flex;">${m.stats.map((s) => statBlock(s, m.accent)).join('')}</div>`;
  return cardShell(m.accent, 'DRep', body);
}

// Consumption gauge for the treasury Net Change Limit card: a rounded track
// with a single fill, the brand accent color, matching the in-app NclPanel gauge.
function gauge(pct: number, color: string): string {
  return `<div style="display:flex;width:1010px;height:32px;border-radius:16px;background:${TRACK};overflow:hidden;">
    <div style="display:flex;width:${pct}%;height:100%;background:${color};"></div>
  </div>`;
}

export function treasuryCardHtml(m: TreasuryCardModel): string {
  const body = `<div style="display:flex;flex-direction:column;">
      ${title(m.label)}
      <div style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-top:8px;">${esc(m.epochRange)}</div>
    </div>
    <div style="display:flex;flex-direction:column;">
      ${gauge(m.pct, m.gaugeColor)}
      <div style="display:flex;font-size:56px;font-weight:800;margin-top:24px;letter-spacing:-1px;">${esc(m.headline)}</div>
      <div style="display:flex;font-size:28px;font-weight:500;color:${MUTED};margin-top:8px;">${esc(m.amounts)}</div>
    </div>`;
  return cardShell(m.accent, 'Treasury', body);
}

// A small filled triangle as an SVG data URL (the proven satori image path). Used
// for the gainer/loser direction instead of the ▲/▼ glyphs, which are not in the
// Plus Jakarta Sans subset and would render as tofu.
function triangle(dir: 'up' | 'down', color: string, size: number): string {
  const points = dir === 'up' ? '12,5 20,19 4,19' : '12,19 20,5 4,5';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><polygon points="${points}" fill="${color}"/></svg>`;
  return `<img src="data:image/svg+xml;base64,${btoa(svg)}" width="${size}" height="${size}" />`;
}

function moverRowHtml(r: MoverRow, index: number, dir: 'up' | 'down', color: string): string {
  // Prefer the percent as the headline figure; fall back to the ada delta when the
  // previous snapshot was zero (percent undefined). The ada line only repeats below
  // when the percent is the headline, so it never shows twice. No avatars here: six
  // embedded raster avatars overrun the render's CPU budget, so the card stays text.
  const headline = r.pct ?? r.ada;
  const sub = r.pct
    ? `<div style="display:flex;font-size:22px;font-weight:500;color:${MUTED};">${esc(r.ada)}</div>`
    : '';
  return `<div style="display:flex;align-items:center;margin-bottom:24px;">
      <span style="display:flex;width:36px;font-size:26px;font-weight:700;color:${SUBTLE};">${index + 1}</span>
      <div style="display:flex;flex:1;overflow:hidden;font-size:30px;font-weight:700;color:${INK};margin-right:16px;">${esc(r.name)}</div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;align-items:center;font-size:30px;font-weight:800;color:${color};">
          <span style="display:flex;margin-right:8px;">${triangle(dir, color, 20)}</span>${esc(headline)}
        </div>
        ${sub}
      </div>
    </div>`;
}

function moversColumn(heading: string, dir: 'up' | 'down', rows: MoverRow[]): string {
  const color = dir === 'up' ? TALLY.yes : TALLY.no;
  const head = `<div style="display:flex;align-items:center;margin-bottom:22px;">
      <span style="display:flex;margin-right:10px;">${triangle(dir, color, 22)}</span>
      <span style="display:flex;font-size:28px;font-weight:700;color:${INK};">${esc(heading)}</span>
    </div>`;
  const list = rows.length
    ? rows.map((r, i) => moverRowHtml(r, i, dir, color)).join('')
    : `<div style="display:flex;font-size:24px;font-weight:500;color:${MUTED};">No ${dir === 'up' ? 'gainers' : 'losers'} this epoch.</div>`;
  // The gainers column reserves right-hand gutter so the two lists don't collide.
  const gutter = dir === 'up' ? 'margin-right:56px;' : '';
  return `<div style="display:flex;flex-direction:column;flex:1;${gutter}">${head}${list}</div>`;
}

export function moversCardHtml(m: MoversCardModel): string {
  const body = `<div style="display:flex;flex-direction:column;">
      ${title('Movers of the epoch')}
      <div style="display:flex;font-size:26px;font-weight:500;color:${MUTED};margin-top:10px;">${esc(m.subtitle)}</div>
    </div>
    <div style="display:flex;">
      ${moversColumn('Top gainers', 'up', m.gainers)}
      ${moversColumn('Top losers', 'down', m.losers)}
    </div>`;
  return cardShell(m.accent, `Movers · ${m.epochLabel}`, body);
}

// Also renders help-guide cards: helpCardModel returns the same shape with no
// author row, so a footer/layout change here restyles /og/help/* too.
export function discussionCardHtml(m: DiscussionCardModel): string {
  const footer = m.authorName
    ? `<div style="display:flex;align-items:center;">
        ${m.avatarDataUrl ? `<img src="${m.avatarDataUrl}" width="52" height="52" style="border-radius:999px;margin-right:14px;" />` : ''}
        <span style="display:flex;font-size:28px;font-weight:700;color:${INK};">${esc(m.authorName)}</span>
        <span style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-left:14px;">· ${esc(m.meta)}</span>
      </div>`
    : `<div style="display:flex;"><span style="display:flex;font-size:24px;font-weight:500;color:${MUTED};">${esc(m.meta)}</span></div>`;
  const subtitle = m.subtitle
    ? `<div style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-top:16px;line-height:1.35;max-width:1010px;">${esc(m.subtitle)}</div>`
    : '';
  const titleBlock = `<div style="display:flex;flex-direction:column;">${title(m.title)}${subtitle}</div>`;
  return cardShell(m.accent, m.category, `${titleBlock}${footer}`);
}

// Help-guide card. Full-bleed layout: no illustration panel, the artwork sits
// flush against the right edge as a standalone motif, and the meta footer is
// dropped so the description can be set larger. The left column carries the
// header, title and description with its own inner padding, so the bottom
// accent bar (from the shared shell dimensions) and the illustration are the
// only things touching the card edges. Without an illustration the layout
// falls back to the plain wide text shell.
export function helpCardHtml(m: DiscussionCardModel & { illustrationDataUrl?: string | null }): string {
  const hasIllo = Boolean(m.illustrationDataUrl);
  if (!hasIllo) {
    const subtitle = m.subtitle
      ? `<div style="display:flex;font-size:28px;font-weight:500;color:${MUTED};margin-top:20px;line-height:1.4;max-width:1010px;">${esc(m.subtitle)}</div>`
      : '';
    const titleBlock = `<div style="display:flex;flex-direction:column;">${title(m.title)}${subtitle}</div>`;
    return cardShell(BRAND_ACCENT, m.category, titleBlock);
  }
  const illo = `<img src="${m.illustrationDataUrl}" width="460" height="460" style="flex-shrink:0;" />`;
  const subtitle = m.subtitle
    ? `<div style="display:flex;font-size:32px;font-weight:500;color:${MUTED};margin-top:24px;line-height:1.4;">${esc(m.subtitle)}</div>`
    : '';
  const titleBlock = `<div style="display:flex;flex-direction:column;flex:1;padding-right:40px;">
      ${title(m.title, 620)}
      ${subtitle}
    </div>`;
  // flex-direction:column so header() stretches to full width (a row flex item
  // has main-axis natural width; here we need it wide so its inner
  // justify-content:space-between actually pushes the pill to the right edge).
  const headerRow = `<div style="display:flex;flex-direction:column;padding-right:44px;">${header(pill(m.category, BRAND_ACCENT))}</div>`;
  const body = `<div style="display:flex;align-items:center;flex:1;">${titleBlock}${illo}</div>`;
  // Custom shell (not cardShell) because the illustration bleeds to the right
  // edge, so the content column has zero right padding, only the left/top/bottom.
  // Bottom bar matches the shared cardShell for visual consistency.
  return compact(`<div style="display:flex;flex-direction:column;width:1200px;height:${OG_HEIGHT}px;background:${CARD_BG};font-family:'Plus Jakarta Sans','Ada';color:${INK};">
    <div style="display:flex;flex-direction:column;flex:1;padding:40px 0 32px 48px;">
      ${headerRow}
      ${body}
    </div>
    <div style="display:flex;width:1200px;height:12px;background:${BRAND_ACCENT};"></div>
  </div>`);
}

export function voteCardHtml(m: VoteCardModel): string {
  const idLine = m.idShort
    ? `<div style="display:flex;font-size:24px;font-weight:500;color:${SUBTLE};margin-top:8px;">${esc(m.idShort)}</div>`
    : '';
  const rationale = m.rationaleExcerpt
    ? `<div style="display:flex;align-items:flex-start;margin-top:24px;max-width:1010px;">
        <div style="display:flex;font-size:110px;font-weight:800;color:${tint(BRAND_ACCENT)};line-height:0.8;margin-right:18px;">“</div>
        <div style="display:flex;font-size:26px;font-weight:500;color:${MUTED};line-height:1.4;padding-top:14px;">${esc(m.rationaleExcerpt)}</div>
      </div>`
    : '';
  // Same grammar as drepCardHtml (identity + avatar, then a bottom block), but the
  // block is offset from the top and given generous internal gaps so the name sits
  // lower and the action title has room to breathe. The headline reads as a
  // sentence, "<Name> voted No", with the vote part coloured.
  const body = `<div style="display:flex;flex-direction:column;flex:1;padding-top:104px;">
      <div style="display:flex;align-items:center;">
        <div style="display:flex;flex-direction:column;flex:1;padding-right:32px;">
          <div style="display:flex;flex-wrap:wrap;align-items:baseline;font-size:56px;font-weight:800;line-height:1.15;letter-spacing:-1px;">
            <div style="display:flex;">${esc(m.name)}</div>
            <div style="display:flex;color:${m.voteColor};margin-left:18px;">${esc(m.votePhrase)}</div>
          </div>
          ${idLine}
          <div style="display:flex;font-size:40px;font-weight:800;line-height:1.2;margin-top:44px;">${esc(m.actionTitle)}</div>
        </div>
        <img src="${m.avatarDataUrl}" width="160" height="160" style="border-radius:80px;" />
      </div>
      ${rationale}
    </div>`;
  return cardShell(BRAND_ACCENT, m.roleLabel, body);
}
