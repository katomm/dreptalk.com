// Static Open Graph card model for the Find your DRep quiz at /match/.
//
// One generic card serves every share of the quiz on purpose: answers travel in
// the URL fragment, which never reaches the server, so a personalized result
// card is impossible by design. Shared by the /og/match.png route (renders it)
// and the /match/ page (versions its og:image URL from the same fields).
import type { DiscussionCardModel } from './model.js';
import { BRAND_ACCENT } from './theme.js';
import { ogCardVersion } from './version.js';

export const MATCH_CARD: DiscussionCardModel = {
  accent: BRAND_ACCENT,
  category: 'Voting match',
  title: 'Find your DRep',
  subtitle:
    'Answer real Cardano governance actions and see which DReps vote like you. Your answers never leave your device.',
  authorName: null,
  avatarDataUrl: null,
  meta: 'Find your DRep',
};

/**
 * Revision of the drawing the card embeds (public/help/og/drep-matching.png).
 * Bump it when that file is replaced, the copy alone does not know.
 */
const MATCH_CARD_ILLUSTRATION_REV = 2;

/** Cache-busting token for the card URL, changes whenever the card copy or drawing changes. */
export function matchCardVersion(): string {
  return ogCardVersion([
    MATCH_CARD.category,
    MATCH_CARD.title,
    MATCH_CARD.subtitle,
    MATCH_CARD_ILLUSTRATION_REV,
  ]);
}
