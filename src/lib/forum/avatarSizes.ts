// Shared avatar edge lengths (px) so identity icons stay consistent by role
// instead of each surface picking its own number. Three buckets on an 8px step:
//   rowLead: the avatar that leads a primary, full-width identity list and is
//            the visual anchor of the row: the activity feed, the topic
//            overview, the DRep directory, and the governance positions list.
//   card:    identity inside a bordered card and thread post authors: the
//            sidebar proposer / participant / recently-active cards and a post
//            or thread-header author. Matches the proposer icon in a gov row.
//   compact: dense or secondary contexts: in-thread replies.
export const AVATAR_SIZE = {
  rowLead: 40,
  card: 32,
  compact: 24,
} as const;
