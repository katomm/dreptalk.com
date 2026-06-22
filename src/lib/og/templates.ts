// HTML-string builders for the OG cards. workers-og (satori) renders these to a
// 1200x630 PNG. Constraints baked in: every multi-child container sets an
// explicit display:flex (satori needs it), colours are literal hex, and images
// are passed as data URLs. compact() strips inter-tag whitespace because satori
// otherwise treats the newlines/indentation as empty flex children and skews
// justify-content (it pushed the header logo off the left edge).

import { BRAND_ACCENT, CARD_BG, INK, MUTED, OG_HEIGHT, SUBTLE, TALLY, TRACK, tint } from './theme.js';
import type { DiscussionCardModel, DrepCardModel, DrepStat, GovCardModel } from './model.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Collapse whitespace that sits purely between tags. Text content (which always
// has non-space characters) is never matched, so labels keep their spaces.
function compact(html: string): string {
  return html.replace(/>\s+</g, '><').trim();
}

function header(logoDataUrl: string, rightPill: string): string {
  return `<div style="display:flex;align-items:center;justify-content:space-between;">
    <div style="display:flex;align-items:center;">
      <img src="${logoDataUrl}" width="56" height="56" style="margin-right:14px;" />
      <span style="font-size:32px;font-weight:700;letter-spacing:-0.3px;">DRepTalk</span>
    </div>
    ${rightPill}
  </div>`;
}

function pill(text: string, color: string): string {
  return `<span style="display:flex;font-size:24px;font-weight:600;color:${color};background:${tint(color)};padding:10px 22px;border-radius:999px;text-transform:uppercase;letter-spacing:0.5px;">${esc(text)}</span>`;
}

// The shared frame for every card: white canvas, accent bar, padded content
// column with the brand header on top and the card-specific body below. The
// three builders differ only in their pill label and body.
function cardShell(accent: string, logoDataUrl: string, pillText: string, body: string): string {
  return compact(`<div style="display:flex;width:1200px;height:${OG_HEIGHT}px;background:${CARD_BG};font-family:'Plus Jakarta Sans','Ada';color:${INK};">
    <div style="display:flex;width:12px;height:${OG_HEIGHT}px;background:${accent};"></div>
    <div style="display:flex;flex-direction:column;justify-content:space-between;flex:1;padding:40px 44px;">
      ${header(logoDataUrl, pill(pillText, accent))}
      ${body}
    </div>
  </div>`);
}

function title(text: string): string {
  return `<div style="display:flex;font-size:56px;font-weight:800;line-height:1.15;letter-spacing:-1px;max-width:1010px;">${esc(text)}</div>`;
}

function tallyBlock(t: { yes: number; no: number; abstain: number }): string {
  const seg = (w: number, c: string) => `<div style="display:flex;width:${w}%;height:20px;background:${c};"></div>`;
  // A filled dot in the segment colour leads each label, matching the mockup.
  const label = (n: number, name: string, color: string) =>
    `<div style="display:flex;align-items:center;margin-right:28px;">
      <div style="display:flex;width:14px;height:14px;border-radius:7px;background:${color};margin-right:9px;"></div>
      <span style="font-size:24px;font-weight:700;color:${INK};">${Math.round(n)}%</span>
      <span style="font-size:24px;font-weight:500;color:${MUTED};margin-left:6px;">${name}</span>
    </div>`;
  return `<div style="display:flex;flex-direction:column;">
    <div style="display:flex;width:1010px;height:20px;border-radius:10px;overflow:hidden;background:${TRACK};">
      ${seg(t.yes, TALLY.yes)}${seg(t.no, TALLY.no)}${seg(t.abstain, TALLY.abstain)}
    </div>
    <div style="display:flex;margin-top:12px;">${label(t.yes, 'Yes', TALLY.yes)}${label(t.no, 'No', TALLY.no)}${label(t.abstain, 'Abstain', TALLY.abstain)}</div>
  </div>`;
}

function votingOpen(): string {
  return `<div style="display:flex;">
    <span style="display:flex;font-size:24px;font-weight:700;color:${BRAND_ACCENT};background:${tint(BRAND_ACCENT)};padding:8px 18px;border-radius:8px;">Voting open</span>
  </div>`;
}

export function govCardHtml(m: GovCardModel, logoDataUrl: string): string {
  const meta = m.meta
    ? `<span style="font-size:24px;font-weight:500;color:${MUTED};margin-left:16px;">${esc(m.meta)}</span>`
    : '';
  const body = `${title(m.title)}
    <div style="display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;margin-bottom:14px;">
        <span style="display:flex;font-size:24px;font-weight:700;color:${m.status.color};background:${m.status.tint};padding:6px 16px;border-radius:8px;">${esc(m.status.label)}</span>
        ${meta}
      </div>
      ${m.tally ? tallyBlock(m.tally) : votingOpen()}
    </div>`;
  return cardShell(m.accent, logoDataUrl, m.typeLabel, body);
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
    ? `<div style="display:flex;font-size:22px;font-weight:500;color:${MUTED};margin-top:4px;">${esc(s.label)}</div>`
    : '';
  return `<div style="display:flex;flex-direction:column;margin-right:40px;">
    <div style="display:flex;align-items:center;">
      ${statIcon(s.icon, accent)}
      <div style="display:flex;font-size:40px;font-weight:800;">${esc(s.value)}</div>
    </div>
    ${label}
  </div>`;
}

export function drepCardHtml(m: DrepCardModel, logoDataUrl: string): string {
  const nameSize = m.name.length > 22 ? 48 : 64;
  const idLine = m.idShort
    ? `<div style="display:flex;font-size:24px;font-weight:500;color:${SUBTLE};margin-top:8px;">${esc(m.idShort)}</div>`
    : '';
  const bioLine = m.bio
    ? `<div style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-top:16px;line-height:1.35;">${esc(m.bio)}</div>`
    : '';
  const body = `<div style="display:flex;align-items:center;">
      <div style="display:flex;flex-direction:column;flex:1;padding-right:32px;">
        <div style="display:flex;font-size:${nameSize}px;font-weight:800;line-height:1.1;letter-spacing:-1px;">${esc(m.name)}</div>
        ${idLine}
        ${bioLine}
      </div>
      <img src="${m.avatarDataUrl}" width="160" height="160" style="border-radius:24px;" />
    </div>
    <div style="display:flex;">${m.stats.map((s) => statBlock(s, m.accent)).join('')}</div>`;
  return cardShell(m.accent, logoDataUrl, 'DRep', body);
}

export function discussionCardHtml(m: DiscussionCardModel, logoDataUrl: string): string {
  const footer = m.authorName
    ? `<div style="display:flex;align-items:center;">
        ${m.avatarDataUrl ? `<img src="${m.avatarDataUrl}" width="52" height="52" style="border-radius:999px;margin-right:14px;" />` : ''}
        <span style="display:flex;font-size:28px;font-weight:700;color:${INK};">${esc(m.authorName)}</span>
        <span style="display:flex;font-size:24px;font-weight:500;color:${MUTED};margin-left:14px;">· ${esc(m.meta)}</span>
      </div>`
    : `<div style="display:flex;"><span style="display:flex;font-size:24px;font-weight:500;color:${MUTED};">${esc(m.meta)}</span></div>`;
  return cardShell(m.accent, logoDataUrl, m.category, `${title(m.title)}${footer}`);
}
