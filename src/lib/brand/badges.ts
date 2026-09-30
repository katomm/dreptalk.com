// Backlink badge builders, shared by /brand (links to DRepTalk) and a DRep's
// share kit (links to the DRep's drep.link).
//
// Self-contained snippets partners can paste to link back to DRepTalk. Design
// constraints: a single <a> root (a plain dofollow link, so it passes link
// equity, which iframes and JS embeds would not), style="" attributes only (survives
// any host CSS and most CSPs), inline SVG logo with a per-snippet gradient id
// so two badges on one page never collide, and neutral colors that read on
// light and dark host backgrounds. The footer badge is the one exception: its
// hover reveal needs real CSS, so it ships a tiny <style> block with a unique
// dtlk- class prefix.
//
// Every string in BadgeOptions is inserted as given, so callers pass text that
// is already safe HTML. Runs in the browser as well as on the server.

export type BadgeKind = 'footer' | 'sidebar' | 'banner';

export interface BadgeSnippet {
  kind: BadgeKind;
  title: string;
  note: string;
  html: string;
}

export interface BadgeOptions {
  href: string;
  /** Prefix for the SVG gradient ids, so badges from two sets never collide. */
  idPrefix: string;
  notes: Record<BadgeKind, string>;
  footer: { name: string; reveal: string; title: string };
  sidebar: { heading: string; body: string };
  banner: { heading: string; body: string; cta: string };
  /** Layout for text the caller does not control. The defaults are the /brand
   *  output, which a fixture pins byte for byte. */
  layout?: {
    /** Class prefix of the footer pill's <style> block. A second set on the
     *  same host page needs its own, or the last <style> wins for both. */
    footerClass?: string;
    /** Room for the footer pill's hover reveal, in px. */
    revealMaxPx?: number;
    /** Let headings and the banner's call to action wrap anywhere, for long
     *  unbroken names and short links. */
    wrapText?: boolean;
  };
}

const badgeFont = "system-ui,-apple-system,'Segoe UI',sans-serif";
const badgeBg = 'rgba(128,128,128,.08)';
const badgeBorder = '1px solid rgba(128,128,128,.32)';
const gradStops = ['#8b5cf6', '#3b82f6', '#2dd4bf'];

// Inline copy of /logo.svg, minified, gradient id namespaced per snippet.
const badgeLogo = (id: string, size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="${size}" height="${size}" aria-hidden="true" style="flex:none;">` +
  `<defs><linearGradient id="${id}" x1="8" y1="56" x2="66" y2="16" gradientUnits="userSpaceOnUse">` +
  `<stop offset="0" stop-color="${gradStops[0]}"/><stop offset=".5" stop-color="${gradStops[1]}"/><stop offset="1" stop-color="${gradStops[2]}"/>` +
  `</linearGradient></defs>` +
  `<g stroke="url(#${id})" stroke-width="2.4" stroke-linecap="round">` +
  `<line x1="36" y1="27.5" x2="36" y2="19.5"/><line x1="42" y1="30" x2="47.7" y2="24.3"/>` +
  `<line x1="44.5" y1="36" x2="52.5" y2="36"/><line x1="42" y1="42" x2="47.7" y2="47.7"/>` +
  `<line x1="36" y1="44.5" x2="36" y2="52.5"/><line x1="30" y1="42" x2="24.3" y2="47.7"/>` +
  `<line x1="27.5" y1="36" x2="19.5" y2="36"/><line x1="30" y1="30" x2="24.3" y2="24.3"/></g>` +
  `<g fill="url(#${id})">` +
  `<circle cx="36" cy="15" r="4"/><circle cx="50.85" cy="21.15" r="4"/><circle cx="57" cy="36" r="4"/>` +
  `<circle cx="50.85" cy="50.85" r="4"/><circle cx="36" cy="57" r="4"/><circle cx="21.15" cy="50.85" r="4"/>` +
  `<circle cx="15" cy="36" r="4"/><circle cx="21.15" cy="21.15" r="4"/></g>` +
  `<g fill="url(#${id})">` +
  `<circle cx="47.1" cy="9.2" r="2"/><circle cx="62.8" cy="24.9" r="2"/><circle cx="62.8" cy="47.1" r="2"/>` +
  `<circle cx="47.1" cy="62.8" r="2"/><circle cx="24.9" cy="62.8" r="2"/><circle cx="9.2" cy="47.1" r="2"/>` +
  `<circle cx="9.2" cy="24.9" r="2"/><circle cx="24.9" cy="9.2" r="2"/></g>` +
  `<circle cx="36" cy="36" r="7" fill="url(#${id})"/></svg>`;

export function buildBadges(o: BadgeOptions): BadgeSnippet[] {
  const fc = o.layout?.footerClass ?? 'dtlk';
  const revealMax = o.layout?.revealMaxPx ?? 220;
  const wrap = o.layout?.wrapText ? 'overflow-wrap:anywhere;' : '';
  const ctaFlow = o.layout?.wrapText ? 'overflow-wrap:anywhere;' : 'white-space:nowrap;';
  const footer =
    `<style>` +
    `.${fc}{display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 8px;border:${badgeBorder};border-radius:999px;background:${badgeBg};text-decoration:none;color:inherit;font:500 12px/1.2 ${badgeFont};}` +
    `.${fc}-x{display:inline-block;vertical-align:bottom;max-width:0;overflow:hidden;white-space:nowrap;opacity:0;transition:max-width .35s ease,opacity .25s ease;}` +
    `.${fc}:hover .${fc}-x,.${fc}:focus-visible .${fc}-x{max-width:${revealMax}px;opacity:.85;}` +
    `@media (prefers-reduced-motion:reduce){.${fc}-x{transition:none;}}` +
    `</style>` +
    `<a href="${o.href}" class="${fc}" title="${o.footer.title}">` +
    badgeLogo(`${o.idPrefix}-fb`, 16) +
    `<span style="opacity:.9;white-space:nowrap;">${o.footer.name}<span class="${fc}-x">${o.footer.reveal}</span></span></a>`;

  const sidebar =
    `<a href="${o.href}" style="display:block;max-width:300px;box-sizing:border-box;padding:16px;border:${badgeBorder};border-radius:14px;background:${badgeBg};text-decoration:none;color:inherit;font-family:${badgeFont};">` +
    `<span style="display:flex;align-items:center;gap:10px;">` +
    badgeLogo(`${o.idPrefix}-sc`, 34) +
    `<span style="font-size:17px;font-weight:700;letter-spacing:-.01em;${wrap}">${o.sidebar.heading}</span></span>` +
    `<span style="display:block;margin-top:9px;font-size:13px;line-height:1.5;opacity:.75;">${o.sidebar.body}</span>` +
    `<span style="display:block;height:3px;width:44px;margin-top:12px;border-radius:2px;background:linear-gradient(90deg,${gradStops.join(',')});"></span></a>`;

  const banner =
    `<a href="${o.href}" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;max-width:728px;box-sizing:border-box;padding:14px 18px;border:${badgeBorder};border-radius:14px;background:${badgeBg};text-decoration:none;color:inherit;font-family:${badgeFont};">` +
    badgeLogo(`${o.idPrefix}-bn`, 36) +
    `<span style="flex:1;min-width:200px;">` +
    `<span style="display:block;font-size:15px;font-weight:700;${wrap}">${o.banner.heading}</span>` +
    `<span style="display:block;margin-top:3px;font-size:13px;line-height:1.45;opacity:.72;">${o.banner.body}</span></span>` +
    `<span style="font-size:12.5px;font-weight:600;color:#8b5cf6;${ctaFlow}">${o.banner.cta}</span></a>`;

  return [
    { kind: 'footer', title: 'Footer badge', note: o.notes.footer, html: footer },
    { kind: 'sidebar', title: 'Sidebar card', note: o.notes.sidebar, html: sidebar },
    { kind: 'banner', title: 'Banner', note: o.notes.banner, html: banner },
  ];
}

/** The generic badges on /brand, linking to DRepTalk itself. Their html is
 *  pinned byte for byte by a test: partners have already pasted them. */
export const BRAND_BADGES: BadgeSnippet[] = buildBadges({
  href: 'https://dreptalk.com/',
  idPrefix: 'dtg',
  notes: {
    footer:
      'Compact pill for footers. Collapsed it shows just the mark and name, and the full name slides out on hover or keyboard focus.',
    sidebar: 'Card for sidebars or article footers, up to 300px wide.',
    banner: 'Fluid banner up to 728px wide. It wraps cleanly on small screens.',
  },
  footer: {
    name: 'DRepTalk',
    reveal: '&nbsp;· Cardano Governance Forum',
    title: 'DRepTalk · Cardano Governance Forum',
  },
  sidebar: {
    heading: 'DRepTalk',
    body: 'Follow Cardano governance votes and discuss them with DReps, SPOs and the community.',
  },
  banner: {
    heading: 'DRepTalk · Cardano Governance Forum',
    body: 'Governance actions, voting power and discussions with DReps and SPOs.',
    cta: 'dreptalk.com',
  },
});
