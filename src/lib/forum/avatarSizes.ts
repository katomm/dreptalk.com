// Shared avatar edge lengths (px) so forum identity icons stay consistent by
// role instead of each surface picking its own number. Three buckets:
//   rowLead: the avatar that leads a list row (activity feed actor, topic
//            overview author). It is the visual anchor of the row.
//   post:    an author avatar inside a thread post and the thread header.
//   compact: dense contexts (replies, participant and voter lists, tables).
export const AVATAR_SIZE = {
  rowLead: 40,
  post: 28,
  compact: 24,
} as const;
