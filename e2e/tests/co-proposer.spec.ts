import { resolve } from 'node:path';
import type { Cookie, Page } from '@playwright/test';
import type { KoiosFixture } from './fixtures.js';
import { expect, test } from './fixtures.js';
import { freshAccountIndex, signIn, waitForHydration } from './helpers.js';

// The proposer P from e2e/seed.sql, whose stake address the seed derives from
// this account index. The test checks it still matches. The co-proposer is a
// fresh account per run: new topics are rate-limited per account, and the
// draft step opens one on every run.
const P = { accountIndex: 2147480001, stakeAddr: 'stake_test1uqrf3k3rjdamuy5f30gxkr9wfzd6dm640dzy52e8x4cvjxcnw98lv' };
const C = { accountIndex: freshAccountIndex() };

// P's actions from the seed: two open ones with a thread each, one enacted.
const ACTIONS = [
  {
    id: 'e2ec0a000000000000000000000000000000000000000000000000000000c0a1#0',
    proposalId: 'gov_action1e2ecoproposerpfmsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq1',
    type: 'TreasuryWithdrawals',
  },
  {
    id: 'e2ec0a000000000000000000000000000000000000000000000000000000c0a2#0',
    proposalId: 'gov_action1e2ecoproposersecondqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2',
    type: 'InfoAction',
  },
  {
    id: 'e2ec0a000000000000000000000000000000000000000000000000000000c0a3#0',
    proposalId: 'gov_action1e2ecoproposerfinishedqqqqqqqqqqqqqqqqqqqqqqqqqqqq3',
    type: 'InfoAction',
  },
];
const MAIN = {
  title: 'PFMS: Bringing Government Scale Adoption to Cardano by Trivolve Tech',
  thread: '/t/pfms-bringing-government-scale-adoption-to-cardano-e2ec1/?tab=discussion',
};
const OTHER = {
  title: 'E2E Second Open Action of the Proposer',
  topicId: 'e2e-coprop-topic-2',
  thread: '/t/e2e-second-open-action-of-the-proposer-e2ec2/?tab=discussion',
};
const TEAM = 'Trivolve Tech';
const TEAM_BADGE = `Proposer team · ${TEAM}`;
const CO_NAME = 'Ravi';
const REPLY = `Reply from the proposer team, run ${Date.now()}`;

// Screenshots for a human look at the flow, off by default so CI stays fast.
const SHOTS = process.env.E2E_SCREENSHOTS === '1';
const SHOT_DIR = resolve(import.meta.dirname, '../../test-results/co-proposer-shots');

// From the top, so the sticky header sits where it belongs, and without the
// dev server's toolbar, which only exists under astro dev.
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await waitForHydration(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: resolve(SHOT_DIR, name), fullPage: true, style: 'astro-dev-toolbar { display: none !important; }' });
}

/** Signs P in through the proposer door, with the fixture chain naming P as return address of the seeded actions. */
async function signInProposer(page: Page, koios: KoiosFixture): Promise<void> {
  await koios.set({ proposals: { [P.stakeAddr]: ACTIONS } });
  await signIn(page, 'proposer');
  await page.waitForURL('**/home/');
  await waitForHydration(page);
}

/** A reply POST from inside the page, so it carries the browser's own origin and session cookie. */
async function postReply(page: Page, topicId: string, bodyMd: string): Promise<{ status: number; error?: string }> {
  return page.evaluate(
    async ([id, body]) => {
      const res = await fetch(`/api/topics/${id}/posts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bodyMd: body }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      return { status: res.status, error: json.error };
    },
    [topicId, bodyMd] as const,
  );
}

// The four tests are one story told by two people, each with their own wallet
// and browser context, so they run in order and share the invite link and C's
// session through these variables.
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1280, height: 900 } });

let inviteUrl = '';
let coSession: Cookie[] = [];

test.describe('proposer', () => {
  test.use({ walletOptions: { accountIndex: P.accountIndex } });

  test('sees their governance actions on home and invites a co-proposer with a team name', async ({ page, wallet, koios }) => {
    expect(wallet.addresses.reward).toBe(P.stakeAddr);
    await signInProposer(page, koios);

    await expect(page.getByText('Signed in as proposer of 3 governance actions')).toBeVisible();
    const openList = page.locator('.pa > .pa__list > .pa__item');
    await expect(openList.locator('.pa__title')).toHaveText([MAIN.title, OTHER.title]);
    const finishedToggle = page.getByRole('button', { name: 'Show finished actions (1)' });
    await expect(finishedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.pa').getByText('E2E Finished Action of the Proposer')).toHaveCount(0);
    await shot(page, '01-home-proposer.png');
    if (SHOTS) {
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, '01m-home-proposer-mobile.png');
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    const item = page.locator('.pa__item', { hasText: MAIN.title });
    await item.getByRole('button', { name: 'Invite co-proposer' }).click();
    await item.getByLabel('Team name').selectOption(TEAM);
    await item.getByRole('button', { name: 'Create invite' }).click();
    const created = item.getByRole('status').filter({ hasText: 'Shown only once' });
    await expect(created).toBeVisible();
    inviteUrl = (await created.locator('.pa__inviteurl').textContent()) ?? '';
    expect(inviteUrl).toMatch(/\/co-proposer\/redeem\?code=[A-Za-z0-9_-]+$/);
    await shot(page, '02-invite-created.png');
  });
});

test.describe('co-proposer', () => {
  test.use({ walletOptions: { accountIndex: C.accountIndex } });

  test('redeems the invite and writes as proposer team only in that action thread and in drafts', async ({ page }) => {
    expect(inviteUrl, 'the invite link from the proposer test').not.toBe('');

    // A fresh browser context, signed out: the invite names action and team before anything is signed.
    await page.goto(inviteUrl);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: 'You have been invited' })).toBeVisible();
    await expect(page.getByText(MAIN.title)).toBeVisible();
    await expect(page.getByText(ACTIONS[0]!.id)).toBeVisible();
    await expect(page.getByText(`Team: ${TEAM}`)).toBeVisible();
    await shot(page, '03-redeem-page.png');

    await page.getByLabel('How should your posts be attributed?').fill(CO_NAME);
    await page.getByRole('button', { name: 'Sign and join' }).click();
    await page.waitForURL('**/home/');
    await waitForHydration(page);

    const mandates = page.locator('section', { has: page.getByText('You write for', { exact: true }) });
    await expect(mandates.locator('.pa__title')).toHaveText([MAIN.title]);
    await expect(mandates).toContainText(TEAM_BADGE);
    await shot(page, '04-home-co-proposer.png');

    // The action's own thread: the reply composer is there, the reply carries the team badge.
    await page.goto(MAIN.thread);
    await waitForHydration(page);
    await page.getByPlaceholder('Write your message in Markdown...').fill(REPLY);
    await page.getByRole('button', { name: 'Post reply' }).click();
    const reply = page.locator('article', { hasText: REPLY });
    await expect(reply).toBeVisible();
    // The composer lands on the new post through a fragment, a plain load
    // keeps the page at its top for the screenshot.
    await page.goto(MAIN.thread);
    await expect(reply).toContainText(CO_NAME);
    const badge = reply.locator('.author-identity__badge--mandate');
    await expect(badge).toHaveText(TEAM_BADGE);
    await expect(badge).toHaveAttribute('title', /^Invited by .+, which submitted this action$/);
    await shot(page, '05-thread-team-badge.png');

    // Another thread of the same return address: no composer, and the API refuses a reply.
    await page.goto(OTHER.thread);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: OTHER.title })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Post reply' })).toHaveCount(0);
    expect(await postReply(page, OTHER.topicId, 'Not covered by the grant.')).toEqual({ status: 403, error: 'forbidden' });
    await shot(page, '06-other-thread-no-composer.png');

    // Proposal Drafts: one proposer and no writer role of its own, so no picker,
    // and the draft is written for that proposer.
    await page.goto('/c/proposal-drafts/');
    await waitForHydration(page);
    await expect(page.getByLabel('Post as')).toHaveCount(0);
    await page.getByLabel('Title').fill(`E2E draft for the proposer ${Date.now()}`);
    const created = page.waitForResponse((r) => r.url().endsWith('/api/topics') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Post topic' }).click();
    expect((await created).status()).toBe(201);
    await page.waitForURL('**/t/**');
    await waitForHydration(page);
    const draftBadge = page.locator('article').first().locator('.author-identity__badge--mandate');
    await expect(draftBadge).toHaveText(/^for \S+/);
    await expect(draftBadge).not.toContainText('Proposer team');
    await shot(page, '07-draft-for-badge.png');

    coSession = await page.context().cookies();
  });
});

test.describe('proposer again', () => {
  test.use({ walletOptions: { accountIndex: P.accountIndex } });

  test('sees the co-proposer under the action and removes them', async ({ page, koios }) => {
    await signInProposer(page, koios);
    const item = page.locator('.pa__item', { hasText: MAIN.title });
    const grant = item.locator('.pa__grant', { hasText: CO_NAME });
    await expect(grant).toContainText(TEAM_BADGE);
    await grant.getByRole('button', { name: 'Remove' }).click();
    await expect(item.locator('.pa__grant', { hasText: CO_NAME })).toHaveCount(0);
    await expect(item).toContainText('No co-proposers');
    await shot(page, '08-home-after-remove.png');
  });
});

test.describe('co-proposer after removal', () => {
  test.use({ walletOptions: { accountIndex: C.accountIndex } });

  test('keeps the old badge but can no longer reply in the action thread', async ({ page }) => {
    expect(coSession, 'the session from the co-proposer test').not.toHaveLength(0);
    // The same session as before the removal: the write re-checks the grant, not the session.
    await page.context().addCookies(coSession);

    await page.goto('/home/');
    await expect(page.getByText('You write for', { exact: true })).toHaveCount(0);

    await page.goto(MAIN.thread);
    await waitForHydration(page);
    const reply = page.locator('article', { hasText: REPLY });
    await expect(reply.locator('.author-identity__badge--mandate')).toHaveText(TEAM_BADGE);
    await expect(page.getByRole('button', { name: 'Post reply' })).toHaveCount(0);
    expect(await postReply(page, 'e2e-coprop-topic-1', 'After the removal.')).toEqual({ status: 403, error: 'forbidden' });
  });
});
