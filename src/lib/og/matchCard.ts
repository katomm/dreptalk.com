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

/** Cache-busting token for the card URL, changes whenever the card copy changes. */
export function matchCardVersion(): string {
  return ogCardVersion([MATCH_CARD.category, MATCH_CARD.title, MATCH_CARD.subtitle]);
}
