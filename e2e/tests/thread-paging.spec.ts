import { expect, type Page, test } from '@playwright/test';

// Paging fixtures from e2e/seed.sql. A page holds 50 top-level posts: one plain
// topic with exactly 50, one with 60 and a reply under post 53, and a governance
// action whose discussion has the system opener plus 59 posts.
const P50 = '/t/e2e-thread-paging-fifty-e2e7a5/';
const P60 = '/t/e2e-thread-paging-sixty-e2e7a6/';
const GA = '/t/e2e-thread-paging-governance-e2e7a7/';
const LONG = '/t/e2e-thread-map-long-thread-e2e7a1/';

const articles = (page: Page) => page.locator('.thread-posts article[data-post-id]');
const next = (page: Page) => page.locator('[data-pager="next"]');
const prev = (page: Page) => page.locator('[data-pager="prev"]');
const status = (page: Page) => page.locator('[data-pager-status]');

/** Path, query and hash of the page's current URL. */
const where = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search + url.hash;
};

/** Whether the post's top edge is inside the viewport. */
const postInView = (page: Page, id: string) =>
  page.evaluate((postId) => {
    const el = document.getElementById(`post-${postId}`);
    if (!el) return false;
    const top = el.getBoundingClientRect().top;
    return top >= 0 && top < window.innerHeight;
  }, id);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('a thread of exactly one full page has no pager', async ({ page }) => {
  await page.goto(P50);
  await expect(articles(page)).toHaveCount(50);
  await expect(next(page)).toHaveCount(0);
  await expect(status(page)).toHaveCount(0);
});

test('a longer thread pages at 50 top-level posts and says where it is', async ({ page }) => {
  await page.goto(P60);
  await expect(articles(page)).toHaveCount(50);
  await expect(status(page)).toHaveText('Page 1 of 2');
  await expect(prev(page)).toHaveCount(0);
  await expect(next(page)).toHaveAttribute('href', `${P60}?page=2`);

  await next(page).click();
  // Ten top-level posts and the reply under post 53.
  await expect(articles(page)).toHaveCount(11);
  await expect(status(page)).toHaveText('Page 2 of 2');
  await expect(next(page)).toHaveCount(0);
  await expect(prev(page)).toHaveAttribute('href', P60);
});

test('a page past the end goes to the last page, a bad page number is page 1', async ({ page }) => {
  await page.goto(`${P60}?page=9`);
  expect(where(page)).toBe(`${P60}?page=2`);
  await expect(articles(page)).toHaveCount(11);

  await page.goto(`${P50}?page=2`);
  expect(where(page)).toBe(P50);
  await expect(articles(page)).toHaveCount(50);

  for (const bad of ['abc', '0', '-3']) {
    await page.goto(`${P50}?page=${bad}`);
    expect(where(page)).toBe(`${P50}?page=${bad}`);
    await expect(articles(page)).toHaveCount(50);
  }
});

test('a governance discussion keeps its tab across pages', async ({ page }) => {
  await page.goto(`${GA}?tab=discussion`);
  await expect(articles(page)).toHaveCount(50);
  await expect(next(page)).toHaveAttribute('href', `${GA}?tab=discussion&page=2`);

  await page.goto(`${GA}?tab=discussion&page=9`);
  expect(where(page)).toBe(`${GA}?tab=discussion&page=2`);
  await expect(articles(page)).toHaveCount(10);
  await expect(prev(page)).toHaveAttribute('href', `${GA}?tab=discussion`);

  // The Positions tab reads the same parameter for its own list.
  await page.goto(`${GA}?tab=positions&page=9`);
  expect(where(page)).toBe(`${GA}?tab=positions&page=9`);
});

test('a link to a post on the second page ends there', async ({ page }) => {
  await page.goto(`${P60}#post-e2e7a600-0000-4000-8000-000000000053`);
  await page.waitForURL(`**${P60}?page=2#post-e2e7a600-0000-4000-8000-000000000053`);
  await expect.poll(() => postInView(page, 'e2e7a600-0000-4000-8000-000000000053')).toBe(true);

  // A reply lives on the page of its top-level post.
  await page.goto(`${P60}#post-e2e7a600-0000-4000-8000-000000000a01`);
  await page.waitForURL(`**${P60}?page=2#post-e2e7a600-0000-4000-8000-000000000a01`);
  await expect.poll(() => postInView(page, 'e2e7a600-0000-4000-8000-000000000a01')).toBe(true);

  // A stale page number is corrected the same way.
  await page.goto(`${P60}?page=2#post-e2e7a600-0000-4000-8000-000000000003`);
  await page.waitForURL(`**${P60}#post-e2e7a600-0000-4000-8000-000000000003`);
  await expect.poll(() => postInView(page, 'e2e7a600-0000-4000-8000-000000000003')).toBe(true);
});

test('a post link on a governance action opens the discussion tab', async ({ page }) => {
  await page.goto(`${GA}#post-e2e7a700-0000-4000-8000-000000000005`);
  await page.waitForURL(`**${GA}?tab=discussion#post-e2e7a700-0000-4000-8000-000000000005`);
  await expect.poll(() => postInView(page, 'e2e7a700-0000-4000-8000-000000000005')).toBe(true);

  await page.goto(`${GA}#post-e2e7a700-0000-4000-8000-000000000055`);
  await page.waitForURL(`**${GA}?tab=discussion&page=2#post-e2e7a700-0000-4000-8000-000000000055`);
  await expect.poll(() => postInView(page, 'e2e7a700-0000-4000-8000-000000000055')).toBe(true);
});

test('a link to an unknown post or to a post of another thread stays put', async ({ page }) => {
  const missing = 'e2e7a600-0000-4000-8000-00000000dead';
  const unknown = page.waitForResponse((r) => r.url().includes(`/api/posts/${missing}/location`));
  await page.goto(`${P60}#post-${missing}`);
  expect((await unknown).status()).toBe(404);
  expect(where(page)).toBe(`${P60}#post-${missing}`);

  const other = 'e2e7a500-0000-4000-8000-000000000002';
  const foreign = page.waitForResponse((r) => r.url().includes(`/api/posts/${other}/location`));
  await page.goto(`${P60}#post-${other}`);
  expect((await foreign).status()).toBe(200);
  await page.waitForTimeout(300);
  expect(where(page)).toBe(`${P60}#post-${other}`);
});

test('a hash that cannot be a post id asks nothing', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/location')) asked.push(r.url());
  });
  await page.goto(`${P60}#post-not-an-id`);
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);
  expect(where(page)).toBe(`${P60}#post-not-an-id`);
});

test('a late answer does not pull the reader back after the hash changed', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/posts/e2e7a600-0000-4000-8000-000000000053/location', async (route) => {
    await held;
    await route.continue();
  });
  const answered = page.waitForResponse((r) => r.url().includes('/api/posts/e2e7a600-0000-4000-8000-000000000053/location'));
  await page.goto(`${P60}#post-e2e7a600-0000-4000-8000-000000000053`);
  // The reader moves on to a post of this page while the answer is still out.
  await page.evaluate(() => {
    window.location.hash = '#post-e2e7a600-0000-4000-8000-000000000002';
  });
  release();
  await answered;
  await page.waitForTimeout(300);
  expect(where(page)).toBe(`${P60}#post-e2e7a600-0000-4000-8000-000000000002`);
});

test('a page that holds the linked post asks nothing', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/location')) asked.push(r.url());
  });
  await page.goto(`${LONG}#post-e2e-tmap-long-20`);
  await expect.poll(() => postInView(page, 'e2e-tmap-long-20')).toBe(true);
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);
});

test('the latest hash ends at the last post of the page', async ({ page }) => {
  await page.goto(`${P60}?page=2#latest`);
  await expect.poll(() => postInView(page, 'e2e7a600-0000-4000-8000-000000000060')).toBe(true);
});
