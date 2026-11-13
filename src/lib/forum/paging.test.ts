import { describe, expect, it } from 'vitest';
import { pageCount, resolvePostLink, THREAD_PAGE_SIZE, threadPageUrl } from './paging.js';

describe('pageCount', () => {
  it('is at least 1 and grows with every full page', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(1)).toBe(1);
    expect(pageCount(THREAD_PAGE_SIZE)).toBe(1);
    expect(pageCount(THREAD_PAGE_SIZE + 1)).toBe(2);
    expect(pageCount(100)).toBe(2);
    expect(pageCount(101)).toBe(3);
  });
  it('treats a missing or negative count as one page', () => {
    expect(pageCount(Number.NaN)).toBe(1);
    expect(pageCount(-5)).toBe(1);
  });
  it('takes another page size', () => {
    expect(pageCount(3, 2)).toBe(2);
  });
});

describe('threadPageUrl', () => {
  it('writes the page only above 1 on a plain topic', () => {
    expect(threadPageUrl({ slug: 's', governance: false })).toBe('/t/s/');
    expect(threadPageUrl({ slug: 's', governance: false, page: 1 })).toBe('/t/s/');
    expect(threadPageUrl({ slug: 's', governance: false, page: 3 })).toBe('/t/s/?page=3');
  });
  it('always carries the discussion tab on a governance topic', () => {
    expect(threadPageUrl({ slug: 's', governance: true })).toBe('/t/s/?tab=discussion');
    expect(threadPageUrl({ slug: 's', governance: true, page: 2 })).toBe('/t/s/?tab=discussion&page=2');
  });
  it('appends the hash as given', () => {
    expect(threadPageUrl({ slug: 's', governance: false, hash: '#post-x' })).toBe('/t/s/#post-x');
    expect(threadPageUrl({ slug: 's', governance: false, page: 2, hash: '#post-x' })).toBe('/t/s/?page=2#post-x');
    expect(threadPageUrl({ slug: 's', governance: true, page: 2, hash: '#latest' })).toBe(
      '/t/s/?tab=discussion&page=2#latest',
    );
  });
});

describe('resolvePostLink', () => {
  const plain = (page: number) => ({ topicSlug: 's', tab: null, page }) as const;
  const gov = (page: number) => ({ topicSlug: 's', tab: 'discussion', page }) as const;
  const at = (search: string, pathname = '/t/s/') => ({ pathname, search, hash: '#post-x' });

  it('ignores a post of another topic', () => {
    expect(resolvePostLink(at('', '/t/other/'), plain(2))).toBeNull();
  });
  it('sends a plain link to the page of its post', () => {
    expect(resolvePostLink(at(''), plain(2))).toBe('/t/s/?page=2#post-x');
    expect(resolvePostLink(at('?page=3'), plain(1))).toBe('/t/s/#post-x');
  });
  it('stays when the reader is already on the right page', () => {
    expect(resolvePostLink(at(''), plain(1))).toBeNull();
    expect(resolvePostLink(at('?page=2'), plain(2))).toBeNull();
    expect(resolvePostLink(at('?page=abc'), plain(1))).toBeNull();
  });
  it('sends a governance link to the discussion tab', () => {
    expect(resolvePostLink(at(''), gov(1))).toBe('/t/s/?tab=discussion#post-x');
    expect(resolvePostLink(at('?tab=positions&page=3'), gov(1))).toBe('/t/s/?tab=discussion#post-x');
    expect(resolvePostLink(at('?tab=discussion'), gov(2))).toBe('/t/s/?tab=discussion&page=2#post-x');
  });
  it('stays on the discussion tab of the right page', () => {
    expect(resolvePostLink(at('?tab=discussion'), gov(1))).toBeNull();
    expect(resolvePostLink(at('?tab=discussion&page=2'), gov(2))).toBeNull();
  });
  it('matches the topic with or without the trailing slash', () => {
    expect(resolvePostLink(at('', '/t/s'), plain(1))).toBeNull();
  });
});
