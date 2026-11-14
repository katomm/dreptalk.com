import { expect, type Page, test } from '@playwright/test';

// Thread map fixtures from e2e/seed.sql: a long plain thread (30 posts, six
// replies, one at depth 2), a plain thread with few but long posts, a short
// plain thread and a governance action with a long discussion.
const LONG = '/t/e2e-thread-map-long-thread-e2e7a1/';
const WORDS = '/t/e2e-thread-map-few-long-posts-e2e7a2/';
const SHORT = '/t/e2e-thread-map-short-thread-e2e7a3/';
const GA = '/t/e2e-thread-map-governance-action-e2e7a4/';

const map = (page: Page) => page.locator('.thread-map');
const rows = (page: Page) => page.locator('.thread-map__row');

async function open(page: Page, path: string, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto(path);
}

/** The element's viewport rectangle. */
const rect = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width };
  });

/** Scrolls so the post's top sits just below the sticky header. */
const scrollToPost = (page: Page, id: string) =>
  page.evaluate((postId) => document.getElementById(`post-${postId}`)?.scrollIntoView({ block: 'start' }), id);

const inViewport = async (page: Page, selector: string) => {
  const r = await rect(page, selector);
  const height = page.viewportSize()?.height ?? 0;
  return r.top >= 0 && r.bottom <= height + 1;
};

test('a long plain thread gets the rail and the wide page shape', async ({ page }) => {
  await open(page, SHORT);
  const shortColumn = await rect(page, '.thread-single');
  await expect(map(page)).toBeHidden();

  await open(page, LONG);
  await expect(map(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(30);
  await expect(page.locator('.thread-map__person')).toHaveCount(5);
  await expect(page.locator('[data-tm-pos]')).toHaveText('1 / 30');
  // Each row shows the first words of its post next to the avatar. The
  // author's name is not on screen, it stays in the row's accessible name.
  await expect(rows(page).first().locator('.thread-map__snippet')).toBeVisible();
  await expect(rows(page).first().locator('.thread-map__snippet')).toContainText(/^Post 1 /);
  await expect(page.locator('.thread-map__name')).toHaveCount(0);
  await expect(rows(page).first()).toHaveAttribute('aria-label', /^.+: Post 1 /);
  await expect(rows(page).first()).toHaveAttribute('title', /^.+: Post 1 /);
  // With the rail the page takes the wide shape of the governance pages: the
  // text column grows, and column and rail line up with the header's content.
  const column = await rect(page, '.thread-single');
  const rail = await rect(page, '.thread-map');
  expect(column.width).toBeGreaterThan(shortColumn.width);
  const header = await page.locator('.site-header__inner').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { left: r.left + Number.parseFloat(style.paddingLeft), right: r.right - Number.parseFloat(style.paddingRight) };
  });
  expect(Math.abs(column.left - header.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(rail.right - header.right)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a row jumps to its post below the header', async ({ page }) => {
  await open(page, LONG);
  const target = rows(page).nth(6);
  const href = await target.getAttribute('href');
  await target.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  const header = await rect(page, '.site-header');
  const post = await rect(page, `article${href}`);
  expect(post.top).toBeGreaterThanOrEqual(header.bottom - 1);
  expect(post.top).toBeLessThanOrEqual(header.bottom + 200);
});

test('the rail follows the reading position and stays in view', async ({ page }) => {
  await open(page, LONG);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  await expect(page.locator('[data-tm-pos]')).not.toHaveText('1 / 30');
  expect(await inViewport(page, '.thread-map__card')).toBe(true);
  const current = page.locator('.thread-map__row[aria-current="location"]');
  await expect(current).toHaveCount(1);
  // A computed style, so a selector that misses the script-built rows fails here.
  expect(await current.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');

  // Late in the thread the card still sticks. At the very end of the page it
  // leaves with the end of the reading column, like any sticky element.
  await scrollToPost(page, 'e2e-tmap-long-27');
  expect(await inViewport(page, '.thread-map__card')).toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('[data-tm-pos]')).toHaveText('30 / 30');
});

test('the governance discussion keeps the map in view after the sidebar cards scrolled away', async ({ page }) => {
  await open(page, `${GA}?tab=discussion`);
  await expect(map(page)).toBeVisible();
  // The synced opener is listed as a post but is no participant.
  await expect(rows(page)).toHaveCount(26);
  await expect(page.locator('.thread-map__person')).toHaveCount(5);
  const statusBottom = await page.locator('.ga-detail-layout__sidebar > *').first().evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
  await page.evaluate((y) => window.scrollTo(0, y + 200), statusBottom);
  const atEnd = await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2);
  expect(atEnd).toBe(false);
  expect((await rect(page, '.ga-detail-layout__sidebar > *')).bottom).toBeLessThan(0);
  expect(await inViewport(page, '.thread-map')).toBe(true);

  await scrollToPost(page, 'e2e-tmap-ga-22');
  expect(await inViewport(page, '.thread-map')).toBe(true);
});

test('a low window scrolls the post list inside the card', async ({ page }) => {
  await open(page, LONG, 1440, 600);
  const list = page.locator('.thread-map__list');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const last = await rows(page).last().evaluate((el) => el.getBoundingClientRect());
  const box = await list.evaluate((el) => el.getBoundingClientRect());
  expect(last.bottom).toBeLessThanOrEqual(box.bottom + 1);
  expect(last.top).toBeGreaterThanOrEqual(box.top - 1);
});

test('the participant filter dims other rows and outlines the posts', async ({ page }) => {
  await open(page, LONG);
  const person = page.locator('.thread-map__person').first();
  await person.click();
  await expect(person).toHaveAttribute('aria-pressed', 'true');
  const dimmed = page.locator('.thread-map__row.is-dim');
  expect(await dimmed.count()).toBeGreaterThan(0);
  expect(Number(await dimmed.first().evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  const outlined = page.locator('article.thread-map-hl');
  expect(await outlined.count()).toBeGreaterThan(0);
  expect(await outlined.first().evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

  await person.click();
  await expect(person).toHaveAttribute('aria-pressed', 'false');
  await expect(dimmed).toHaveCount(0);
  await expect(outlined).toHaveCount(0);
});

test('few but long posts reach the word threshold', async ({ page }) => {
  await open(page, WORDS);
  await expect(map(page)).toBeVisible();
  await expect(page.locator('[data-tm-pos]')).toHaveText('1 / 4');
});

test('a depth-2 reply is indented deeper than a direct reply', async ({ page }) => {
  await open(page, LONG);
  const indent = (id: string) =>
    page.locator(`.thread-map__row[href="#post-${id}"]`).evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingInlineStart));
  expect(await indent('e2e-tmap-long-06')).toBeGreaterThan(await indent('e2e-tmap-long-05'));
  expect(await indent('e2e-tmap-long-05')).toBeGreaterThan(await indent('e2e-tmap-long-03'));
});

test('each layout shows the map only where there is room', async ({ page }) => {
  await open(page, LONG, 1000);
  await expect(map(page)).toBeVisible();
  await expect(page.locator('.thread-map__len').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Between 856 and 1000px the text column narrows to make room.
  await open(page, LONG, 890);
  await expect(map(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await rect(page, '.thread-single')).width).toBeGreaterThanOrEqual(576);
  // The narrow rail drops the participant filter and the length bars.
  await expect(page.locator('.thread-map__people')).toBeHidden();
  await expect(page.locator('.thread-map__len').first()).toBeHidden();
  await open(page, LONG, 850);
  await expect(map(page)).toBeHidden();

  await open(page, `${GA}?tab=discussion`, 1100);
  await expect(map(page)).toBeVisible();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(map(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(map(page)).toBeVisible();
});

test('the overview tab and short threads show no map', async ({ page }) => {
  await open(page, GA);
  await expect(map(page)).toHaveCount(0);
  await open(page, SHORT);
  await expect(map(page)).toBeHidden();
});
