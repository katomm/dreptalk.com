// Pure helpers behind the thread map, the navigation rail beside long threads.
// The map is built in the browser from the rendered posts, so these stay free
// of DOM access and are unit tested on their own.

/** A page shows the map from this many rendered posts... */
export const MAP_MIN_POSTS = 8;
/** ...or from this many words of post text, whichever comes first. */
export const MAP_MIN_WORDS = 3000;
/** Reply levels the narrow rail indents, deeper replies sit flush at the cap. */
export const MAP_MAX_INDENT = 3;
/** Length bar of the longest post, and the floor that keeps short posts visible. */
export const BAR_MAX_PX = 36;
export const BAR_MIN_PX = 3;

/** Words in a post's prose text. Whitespace runs split, empty input is 0. */
export function countWords(text: string): number {
  return (text.match(/\S+/gu) ?? []).length;
}

/** The map shows when the page has enough posts or enough text. */
export function shouldShowMap(postCount: number, totalWords: number): boolean {
  return postCount >= MAP_MIN_POSTS || totalWords >= MAP_MIN_WORDS;
}

/**
 * Length bar width in px on a square-root scale, so one very long post does not
 * flatten every other bar. No words gives 0, the longest post gives BAR_MAX_PX
 * and any other post at least BAR_MIN_PX.
 */
export function lengthBarPx(words: number, maxWords: number): number {
  if (words <= 0 || maxWords <= 0) return 0;
  return Math.max(BAR_MIN_PX, Math.round(Math.sqrt(Math.min(words, maxWords) / maxWords) * BAR_MAX_PX));
}

/** Rail indent level: top-level 0, replies their tree depth capped at MAP_MAX_INDENT. */
export function indentLevel(depth: number): number {
  return Math.min(Math.max(depth, 0), MAP_MAX_INDENT);
}

export interface Participant {
  authorId: string;
  authorName: string;
  count: number;
  /** Index of the participant's first post, used to break ties. */
  firstIndex: number;
}

/** Participants by post count descending, ties by first appearance. */
export function groupParticipants(posts: { authorId: string; authorName: string }[]): Participant[] {
  const byId = new Map<string, Participant>();
  posts.forEach((post, index) => {
    const known = byId.get(post.authorId);
    if (known) known.count += 1;
    else byId.set(post.authorId, { authorId: post.authorId, authorName: post.authorName, count: 1, firstIndex: index });
  });
  return [...byId.values()].sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex);
}

/**
 * Index of the current post. tops are the posts' top edges relative to the
 * viewport, in document order, and bandTop is the top of the reading band just
 * below the sticky header. The current post is the last one whose top is at or
 * above bandTop, and the first post while the band is still above it. atEnd
 * (the page is scrolled to its bottom) forces the last post, since a short last
 * post may never reach the band. -1 when there are no posts.
 */
export function currentIndex(tops: number[], bandTop: number, atEnd: boolean): number {
  if (tops.length === 0) return -1;
  if (atEnd) return tops.length - 1;
  let current = 0;
  tops.forEach((top, index) => {
    if (top <= bandTop) current = index;
  });
  return current;
}
