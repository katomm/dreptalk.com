import { PROPOSAL_DRAFTS_CATEGORY_SLUG } from '../../../config/categories.js';

// Markdown length caps for forum posts, shared by the write handlers and the
// composer so the two cannot disagree.
export const POST_BODY_MAX = 20_000;

// A Proposal Drafts opening post is the full text of a governance action before
// submission, with room for the longest real CIP-108 documents (motivation,
// rationale, budget and milestones in one post). Replies in those threads keep
// the normal cap. D1 stores a row up to 2MB, so markdown plus rendered HTML of
// this size fits with ample headroom.
export const DRAFT_OPENING_BODY_MAX = 150_000;

/** The body cap for a post, by its topic's category and whether it opens the thread. */
export function maxPostBody(categorySlug: string | null | undefined, isOpeningPost: boolean): number {
  return isOpeningPost && categorySlug === PROPOSAL_DRAFTS_CATEGORY_SLUG ? DRAFT_OPENING_BODY_MAX : POST_BODY_MAX;
}

// A draft's opening post folds behind "Show full draft" above this many
// characters of plain text, the same fold the governance overview uses for a
// long rationale, so the replies stay within reach.
export const DRAFT_FOLD_CHARS = 5_000;

/** Plain-text length of stored post HTML, so markup does not count toward the fold. */
export function plainTextLength(html: string): number {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}
