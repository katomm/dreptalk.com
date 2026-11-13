// Paging facts of a thread, shared by the thread page, its pager, the thread
// map, the post location endpoint and the script that resolves post links.
// Pure, so the page and the browser agree on every URL.

import { parsePage } from './view.js';

/** Top-level posts per thread page. Replies render with their parent. */
export const THREAD_PAGE_SIZE = 50;

/** Pages a thread with this many top-level posts has, at least 1. */
export function pageCount(topLevelCount: number, pageSize = THREAD_PAGE_SIZE): number {
  if (!Number.isFinite(topLevelCount) || topLevelCount <= 0) return 1;
  return Math.max(1, Math.ceil(topLevelCount / pageSize));
}

/**
 * URL of one page of a thread view. A governance thread lives behind the
 * discussion tab, so its URL always names the tab: without it the page opens
 * the overview, which renders no posts. The page is written only above 1 and
 * the hash is appended as given, with its '#'.
 */
export function threadPageUrl(o: { slug: string; governance: boolean; page?: number; hash?: string }): string {
  const params: string[] = [];
  if (o.governance) params.push('tab=discussion');
  if (o.page !== undefined && o.page > 1) params.push(`page=${o.page}`);
  return `/t/${o.slug}/${params.length ? `?${params.join('&')}` : ''}${o.hash ?? ''}`;
}

/** Where a post renders: its topic, the tab that shows posts there, its page. */
export interface PostLinkTarget {
  topicSlug: string;
  tab: 'discussion' | null;
  page: number;
}

/**
 * Where a post link should take the reader, or null when the reader is already
 * on the right tab and page or the post belongs to another topic. current is
 * the location's pathname, search and hash. The comparison is by meaning, so
 * parameter order and an unparsable page (which the page reads as 1) do not
 * cause a needless navigation.
 */
export function resolvePostLink(
  current: { pathname: string; search: string; hash: string },
  target: PostLinkTarget,
): string | null {
  const path = current.pathname.endsWith('/') ? current.pathname : `${current.pathname}/`;
  if (path !== `/t/${target.topicSlug}/`) return null;
  const params = new URLSearchParams(current.search);
  const governance = target.tab === 'discussion';
  const onTab = !governance || params.get('tab') === 'discussion';
  if (onTab && parsePage(params.get('page')) === target.page) return null;
  return threadPageUrl({ slug: target.topicSlug, governance, page: target.page, hash: current.hash });
}
