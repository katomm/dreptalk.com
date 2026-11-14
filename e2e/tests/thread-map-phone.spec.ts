import { expect, type Page, test } from '@playwright/test';

// The thread map below the width that has room for the rail or the sidebar
// card: a fixed pill with the reading position, which opens the same card as a
// bottom sheet. Fixtures as in thread-map.spec.ts and thread-paging.spec.ts.
const LONG = '/t/e2e-thread-map-long-thread-e2e7a1/';
const SHORT = '/t/e2e-thread-map-short-thread-e2e7a3/';
const GA = '/t/e2e-thread-map-governance-action-e2e7a4/';
const P60 = '/t/e2e-thread-paging-sixty-e2e7a6/';
const GA_PAGED = '/t/e2e-thread-paging-governance-e2e7a7/';

const pill = (page: Page) => page.locator('[data-tm-pill]');
const sheet = (page: Page) => page.locator('[data-tm-sheet]');
const rows = (page: Page) => page.locator('.thread-map__row');
const people = (page: Page) => page.locator('.thread-map__person');
const sheetOpen = (page: Page) => sheet(page).evaluate((el) => (el as HTMLDialogElement).open);

async function openPhone(page: Page, path: string) {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(path);
}

const box = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  });

const scrollToPost = (page: Page, id: string) =>
  page.evaluate((postId) => document.getElementById(`post-${postId}`)?.scrollIntoView({ block: 'start' }), id);

const hash = (page: Page) => new URL(page.url()).hash;

test('a long thread shows the pill on a phone, short threads and other tabs do not', async ({ page }) => {
  await openPhone(page, LONG);
  await expect(pill(page)).toBeVisible();
  await expect(pill(page)).toContainText('1 / 30');
  await expect(pill(page)).toHaveAttribute('aria-label', 'Thread map, post 1 of 30');
  await expect(page.locator('.thread-map')).toBeHidden();
  expect(await sheetOpen(page)).toBe(false);
  expect((await box(page, '[data-tm-pill]')).height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await openPhone(page, SHORT);
  await expect(pill(page)).toBeHidden();
  await openPhone(page, GA);
  await expect(pill(page)).toHaveCount(0);
  await openPhone(page, `${GA}?tab=discussion`);
  await expect(pill(page)).toBeVisible();
  await expect(pill(page)).toContainText('1 / 26');
});

test('the pill follows the reading position', async ({ page }) => {
  await openPhone(page, LONG);
  await scrollToPost(page, 'e2e-tmap-long-12');
  await expect(pill(page)).toContainText('12 / 30');
  const width = await page.locator('[data-tm-pill-bar]').evaluate((el) => (el as HTMLElement).style.width);
  expect(width).toBe('40%');
});

test('the pill opens the sheet with the current row in view and touch-sized rows', async ({ page }) => {
  await openPhone(page, LONG);
  await scrollToPost(page, 'e2e-tmap-long-20');
  await expect(pill(page)).toContainText('20 / 30');
  await pill(page).click();
  expect(await sheetOpen(page)).toBe(true);
  await expect(page.locator('[data-tm-pos]')).toHaveText('20 / 30');
  // No participant filter in the sheet, the post list gets the room.
  await expect(page.locator('.thread-map-sheet .thread-map__people')).toBeHidden();

  const list = await box(page, '.thread-map__list');
  const current = await box(page, '.thread-map__row[aria-current="location"]');
  expect(current.top).toBeGreaterThanOrEqual(list.top - 1);
  expect(current.bottom).toBeLessThanOrEqual(list.bottom + 1);
  for (const index of [0, 3, 19]) {
    const height = await rows(page).nth(index).evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  await page.locator('.thread-map__list').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(rows(page).first().locator('.thread-map__snippet')).toBeVisible();
  await expect(rows(page).first().locator('.thread-map__snippet')).toContainText(/^Post 1 /);
  // The sheet stays inside the viewport and leaves the page above it visible.
  // Measured once it has finished sliding in.
  await sheet(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const dialog = await box(page, '[data-tm-sheet]');
  expect(dialog.bottom).toBeLessThanOrEqual(812 + 1);
  expect(dialog.height).toBeLessThanOrEqual(812 * 0.8 + 1);
});

test('a row in the sheet closes it and jumps to the post below the header', async ({ page }) => {
  await openPhone(page, LONG);
  await pill(page).click();
  await rows(page).nth(19).click();
  expect(await sheetOpen(page)).toBe(false);
  expect(hash(page)).toBe('#post-e2e-tmap-long-20');
  const header = await box(page, '.site-header');
  const post = await box(page, 'article#post-e2e-tmap-long-20');
  expect(post.top).toBeGreaterThanOrEqual(header.bottom - 1);
  expect(post.top).toBeLessThanOrEqual(header.bottom + 200);
  await expect(pill(page)).toContainText('20 / 30');
});

test('close, escape and the backdrop close the sheet without a jump', async ({ page }) => {
  await openPhone(page, LONG);
  await pill(page).click();
  await page.locator('[data-tm-close]').click();
  expect(await sheetOpen(page)).toBe(false);

  await pill(page).click();
  await page.keyboard.press('Escape');
  expect(await sheetOpen(page)).toBe(false);

  await pill(page).click();
  // Above the sheet, on the backdrop.
  await page.mouse.click(187, 40);
  expect(await sheetOpen(page)).toBe(false);
  expect(hash(page)).toBe('');
});

test('the page behind the open sheet does not scroll', async ({ page }) => {
  await openPhone(page, LONG);
  await scrollToPost(page, 'e2e-tmap-long-08');
  const before = await page.evaluate(() => window.scrollY);
  await pill(page).click();
  await page.mouse.move(187, 40);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);

  // Closed again, by any way out, the page scrolls.
  await page.keyboard.press('Escape');
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
});

test('a filter from the wide map is cleared when the map becomes the sheet', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LONG);
  await people(page).first().click();
  expect(await page.locator('article.thread-map-hl').count()).toBeGreaterThan(0);

  // The sheet has nothing to clear a filter with, so none comes along.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(pill(page)).toBeVisible();
  await expect(page.locator('article.thread-map-hl')).toHaveCount(0);
  await pill(page).click();
  await expect(page.locator('.thread-map__row.is-dim')).toHaveCount(0);
});

test('widening the window with the sheet open closes it', async ({ page }) => {
  await openPhone(page, LONG);
  await pill(page).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  expect(await sheetOpen(page)).toBe(false);
  await expect(page.locator('.thread-map')).toBeVisible();
  await expect(pill(page)).toBeHidden();
  await expect(page.locator('.thread-map .thread-map__row')).toHaveCount(30);
  await expect(page.locator('.thread-map .thread-map__people')).toBeVisible();
  // The scroll lock of the sheet is gone.
  await page.evaluate(() => window.scrollTo(0, 900));
  expect(await page.evaluate(() => window.scrollY)).toBe(900);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(pill(page)).toBeVisible();
  await expect(page.locator('.thread-map')).toBeHidden();
});

test('a filter from the wide rail can be cleared in the narrow rail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LONG);
  await people(page).first().click();
  // The narrow rail has no participants of its own, except to clear a filter.
  await page.setViewportSize({ width: 890, height: 800 });
  await expect(page.locator('.thread-map')).toBeVisible();
  await expect(page.locator('.thread-map .thread-map__people')).toBeVisible();
  await page.locator('.thread-map .thread-map__person[aria-pressed="true"]').click();
  await expect(page.locator('.thread-map .thread-map__people')).toBeHidden();
  await expect(page.locator('article.thread-map-hl')).toHaveCount(0);
});

test('the pill is gone past the posts and never sits on the join banner', async ({ page }) => {
  await openPhone(page, LONG);
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = total - 812 - 1200; y <= total - 812; y += 40) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const overlap = await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('[data-tm-pill]');
      const banner = document.querySelector('.join-banner');
      if (!p || !banner || getComputedStyle(p).visibility === 'hidden') return false;
      const a = p.getBoundingClientRect();
      const b = banner.getBoundingClientRect();
      return b.bottom > a.top && b.top < a.bottom && b.right > a.left && b.left < a.right;
    });
    expect(overlap).toBe(false);
  }
  await expect(pill(page)).toBeHidden();
  // Back among the posts it returns.
  await scrollToPost(page, 'e2e-tmap-long-10');
  await expect(pill(page)).toBeVisible();
});

test('a focused text field hides the pill until it loses focus', async ({ page }) => {
  await openPhone(page, LONG);
  // The reply form needs a signed-in writer, a plain field in main stands in.
  await page.evaluate(() => {
    const field = document.createElement('textarea');
    field.id = 'e2e-field';
    document.querySelector('main .thread-posts')?.before(field);
    field.focus({ preventScroll: true });
  });
  await expect(pill(page)).toBeHidden();

  await page.evaluate(() => document.getElementById('e2e-field')?.blur());
  await expect(pill(page)).toBeVisible();
});

test('a post without text gets a row with the author name', async ({ page }) => {
  // Posts hidden for the viewer render no prose. Strip one before the map reads it.
  await page.addInitScript(() => {
    new MutationObserver(() => {
      document.querySelector('#post-e2e-tmap-long-02 .prose')?.remove();
    }).observe(document, { childList: true, subtree: true });
  });
  await openPhone(page, LONG);
  await pill(page).click();
  const row = page.locator('.thread-map__row[href="#post-e2e-tmap-long-02"]');
  await expect(row.locator('.thread-map__snippet')).toHaveCount(0);
  await expect(row.locator('.thread-map__name')).toBeVisible();
  // Every other row shows post text and no name.
  await expect(page.locator('.thread-map__name')).toHaveCount(1);
  expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});

test('the map of a paged thread names the page and links across pages', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(P60);
  await expect(page.locator('[data-tm-page]')).toHaveText('Page 1 of 2');
  await expect(page.locator('[data-tm-latest]')).toHaveAttribute('href', `${P60}?page=2#latest`);
  await expect(page.locator('[data-tm-top]')).toHaveAttribute('href', '#post-e2e7a600-0000-4000-8000-000000000001');
  await page.locator('[data-tm-latest]').click();
  await page.waitForURL(`**${P60}?page=2#latest`);
  await expect
    .poll(() => page.evaluate(() => {
      const top = document.getElementById('post-e2e7a600-0000-4000-8000-000000000060')?.getBoundingClientRect().top ?? -1;
      return top >= 0 && top < window.innerHeight;
    }))
    .toBe(true);
  // The second page is long enough for a map of its own.
  await expect(page.locator('[data-tm-page]')).toHaveText('Page 2 of 2');
  await expect(page.locator('[data-tm-top]')).toHaveAttribute('href', P60);
  await expect(page.locator('[data-tm-latest]')).toHaveAttribute('href', '#post-e2e7a600-0000-4000-8000-000000000060');

  await page.goto(`${GA_PAGED}?tab=discussion`);
  await expect(page.locator('[data-tm-latest]')).toHaveAttribute('href', `${GA_PAGED}?tab=discussion&page=2#latest`);
  await page.goto(`${GA_PAGED}?tab=discussion&page=2`);
  await expect(page.locator('[data-tm-top]')).toHaveAttribute('href', `${GA_PAGED}?tab=discussion`);

  // A single page says nothing about pages.
  await page.goto(LONG);
  await expect(page.locator('[data-tm-page]')).toBeHidden();
});
