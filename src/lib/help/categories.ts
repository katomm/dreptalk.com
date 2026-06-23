// The hub's category buckets, in display order. Also the allowed values for a
// guide's `category` frontmatter, so a typo fails the build instead of dropping
// a guide into an unrendered group.
export const CATEGORY_ORDER = [
  'Start here',
  'For DReps',
  'Understanding governance',
  'About DRepTalk',
] as const;

export type Category = (typeof CATEGORY_ORDER)[number];
