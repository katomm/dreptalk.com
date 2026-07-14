// The glossary hub's group buckets, in display order. Also the allowed values
// for an entry's `group` frontmatter, so a typo fails the build instead of
// dropping an entry into an unrendered group.
export const GROUP_ORDER = [
  'Roles and bodies',
  'Voting and delegation',
  'Governance action types',
] as const;

export type GlossaryGroup = (typeof GROUP_ORDER)[number];
