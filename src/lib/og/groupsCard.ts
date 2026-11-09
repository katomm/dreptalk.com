// Static Open Graph card model for the DRep group directory at /groups/.
//
// One card for the directory, with the drawing of the groups guide. Shared by the
// /og/groups.png route (renders it) and the /groups/ page (versions its og:image URL
// from the same fields).
import type { DiscussionCardModel } from './model.js';
import { BRAND_ACCENT } from './theme.js';
import { ogCardVersion } from './version.js';

export const GROUPS_CARD: DiscussionCardModel = {
  accent: BRAND_ACCENT,
  category: 'Group directory',
  title: 'DRep groups',
  subtitle: 'Councils, parties and collectives of Cardano DReps, recorded on chain. Members may vote together, each one still casts its own vote.',
  authorName: null,
  avatarDataUrl: null,
  meta: 'DRep groups',
};

/** The drawing the card embeds, the one of the groups guide. */
export const GROUPS_CARD_ILLUSTRATION = '/help/og/drep-groups.png';

/**
 * Revision of the drawing at GROUPS_CARD_ILLUSTRATION. Bump it when that file is replaced,
 * the copy alone does not know.
 */
const GROUPS_CARD_ILLUSTRATION_REV = 1;

/** Cache-busting token for the card URL, changes whenever the card copy or drawing changes. */
export function groupsCardVersion(): string {
  return ogCardVersion([GROUPS_CARD.category, GROUPS_CARD.title, GROUPS_CARD.subtitle, GROUPS_CARD_ILLUSTRATION_REV]);
}
