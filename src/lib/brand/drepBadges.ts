// Badges and a share text that a DRep pastes into their own site or social
// profile. Same builders as /brand, pointed at the DRep's drep.link, so a
// visitor lands on the profile with the handle as their origin (the resolver
// adds it). The name is on-chain metadata the DRep controls, with no length
// limit in CIP-119: it is capped first so it cannot break the badge layouts,
// then escaped, because our own settings page renders these snippets as HTML.
// Runs in the browser as well as on the server.
import { buildBadges, type BadgeSnippet } from './badges.js';
import { DREP_LINK_ORIGIN, isRoutableHandle } from '../drepLink/handle.js';
import { escapeHtml } from '../html/escape.js';

export const NAME_CAP = 40;

// Caps on code points, before escaping, so an escape sequence can never be cut.
function capName(name: string): string {
  const chars = [...name.trim()];
  return chars.length > NAME_CAP ? `${chars.slice(0, NAME_CAP - 1).join('')}…` : chars.join('');
}

export function buildDrepBadges(handle: string, name: string | null): BadgeSnippet[] {
  if (!isRoutableHandle(handle)) return [];
  const link = `${DREP_LINK_ORIGIN}/${handle}`;
  const shown = `drep.link/${handle}`;
  const who = name?.trim() ? escapeHtml(capName(name)) : shown;
  return buildBadges({
    href: link,
    idPrefix: 'dtd',
    notes: {
      footer: 'A compact pill for your footer. It shows the mark and "My votes", and your short link slides out on hover.',
      sidebar: 'A card for a sidebar or an article footer, up to 300px wide.',
      banner: 'A banner up to 728px wide that wraps cleanly on small screens.',
    },
    footer: { name: 'My votes', reveal: `&nbsp;· ${shown}`, title: `${who} on DRepTalk` },
    sidebar: { heading: who, body: 'See how I vote on Cardano governance and why, on DRepTalk.' },
    banner: { heading: `${who} on DRepTalk`, body: 'Every vote I cast on Cardano governance, with the reasons behind it.', cta: shown },
  });
}

export function drepShareText(handle: string): string | null {
  if (!isRoutableHandle(handle)) return null;
  return `See how I vote on Cardano governance and why: ${DREP_LINK_ORIGIN}/${handle}`;
}
