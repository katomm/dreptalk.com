// Shared avatar edge lengths (px) so forum identity icons stay consistent by
// role instead of each surface picking its own number. Three buckets:
//   rowLead: the avatar that leads a primary, full-width identity list and is
//            the visual anchor of the row: the activity feed, the topic
//            overview, the DRep directory, and the governance positions list.
//   post:    an author avatar inside a thread post and the thread header.
//   compact: secondary or dense contexts: in-thread replies and the narrow
//            governance sidebar participant card.
export const AVATAR_SIZE = {
  rowLead: 40,
  post: 28,
  compact: 24,
} as const;
