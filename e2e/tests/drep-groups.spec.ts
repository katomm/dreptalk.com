import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn, waitForHydration } from './helpers.js';

// The permissioned group of e2e/seed.sql, managed 2 of 3 by the test wallet's DRep key, Alice and
// Erin, with Bob's request pending and an approval of it collecting signatures.
const GROUP = 'group1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq8zuq9qqqqwesjwz';
const GROUP_NAME = 'E2E Permissioned Council';
const ACTION = 'e2e00000000000000000000000000a01';
const SEEDED_DREP = 'drep1y2jmg4g450lced7q9n34rq6d5vjwkm0ugx6h0894u6ur92s9txn3a';
const ALICE = { drepId: 'drep1ygxk54m7j3q6mrkevcunryrwf4p7e68c93cjk8gzxkhlkps6qcwph', hash: '0d6a577e9441ad8ed9663931906e4d43ece8f82c712b1d0235affb06' };
const ERIN = { drepId: 'drep1yt74jw0m2cq7tdq7aenxmws5cznaz5w5ekdsu9nfrn36nfqv4qv3r', hash: 'fd5939fb5601e5b41eee666dba14c0a7d151d4cd9b0e16691ce3a9a4' };
const CAROL = 'drep1y29ftj8dtzpsd65gsc94f6cvvhnhm74en9ufe30xegqg0xg9gts5g';
const WALLET_KEY = 'a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa';
/** The signing page lists keys as their first 8 and last 6 characters. */
const shortKey = (k: string) => `${k.slice(0, 8)}...${k.slice(-6)}`;

/** A full-page screenshot into E2E_SCREENSHOT_DIR, when the run sets it. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

/** Console errors and uncaught exceptions of the page, collected from now on. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function signInAsSeededDrep(page: Page, koios: { set(s: object): Promise<void> }, drepId: string): Promise<void> {
  // The seed is written for the default test wallet, its DRep key is the group's admin.
  expect(drepId).toBe(SEEDED_DREP);
  await koios.set({ activeDreps: [drepId, ALICE.drepId, ERIN.drepId, CAROL] });
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
}

test('anonymous visitors see the group list and page without action buttons', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto('/groups/');
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: 'DRep groups' })).toBeVisible();
  await expect(page.getByRole('link', { name: GROUP_NAME })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Found a group' })).toHaveCount(0);
  await shot(page, '1a-anonymous-group-list');

  await page.getByRole('link', { name: GROUP_NAME }).click();
  await page.waitForURL(`**/groups/${GROUP}/`);
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: GROUP_NAME })).toBeVisible();
  await expect(page.getByText('Permissioned, confirmed by the group').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members (3)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requests (1)' })).toBeVisible();
  // The island lists the action in progress, without a signing link for an anonymous visitor.
  const island = page.locator('#requests');
  await expect(island.getByText('Approval: collecting signatures')).toBeVisible();
  await expect(island.getByRole('link', { name: 'Open the signing page' })).toHaveCount(0);
  await expect(island.getByRole('button')).toHaveCount(0);
  await shot(page, '1b-anonymous-group-page');
  expect(errors).toEqual([]);
});

test('the founding wizard walks the alone and together paths to the review', async ({ page, wallet, koios }) => {
  await signInAsSeededDrep(page, koios, wallet.drepId);
  const errors = pageErrors(page);
  await page.goto('/groups/new/');
  await waitForHydration(page);

  // Alone: permissioned by default, the viewer is the only founder.
  await expect(page.getByRole('heading', { name: 'How do members join?' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('radio', { name: 'Found alone' })).toBeChecked();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('1 of 1 must sign (100%)')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Name').fill('E2E Solo Group');
  await page.getByRole('button', { name: 'Next' }).click();
  const review = page.getByRole('region', { name: 'Found the group' });
  await expect(review.getByText('Must sign: You')).toBeVisible();
  await expect(review.getByText('Founders: You')).toBeVisible();
  await expect(review.getByText('Management policy: 1 of 1 must sign')).toBeVisible();
  await expect(review.getByText('You found the group alone and sign it in one wallet step.')).toBeVisible();
  // A lone founder signs alone, so the sentence about every founder does not apply.
  await expect(review.getByText('Every founder signs the founding transaction, also when the threshold is lower.')).toHaveCount(0);
  await shot(page, '2a-wizard-review-alone');

  // Together with Carol, a registered key DRep checked by her DRep id.
  await review.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('radio', { name: 'Found together with other DReps' }).check();
  await page.getByLabel('Add a founder by DRep id').fill(CAROL);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove E2E Cofounder Carol' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('2 of 2 must sign (100%)')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel('Name')).toHaveValue('E2E Solo Group');
  await page.getByLabel('Name').fill('E2E Joint Group');
  await page.getByRole('button', { name: 'Next' }).click();
  // Mandatory signers are listed in key hash order.
  await expect(review.getByText('Must sign: E2E Cofounder Carol, You')).toBeVisible();
  await expect(review.getByText('Founders: You, E2E Cofounder Carol')).toBeVisible();
  await expect(review.getByText('Every founder signs the founding transaction, also when the threshold is lower.')).toBeVisible();
  await expect(review.getByText('After you sign, share the signing link with everyone else who must sign.')).toBeVisible();
  await shot(page, '2b-wizard-review-together');
  // Nothing was built or signed.
  expect(await wallet.calls('signTx')).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('an admin sees the request queue, the combined update offer, the policy editor and the dissolve confirmation', async ({ page, wallet, koios }) => {
  await signInAsSeededDrep(page, koios, wallet.drepId);
  const errors = pageErrors(page);
  await page.goto(`/groups/${GROUP}/`);
  await waitForHydration(page);
  const island = page.locator('#requests');
  await expect(island.getByText('You are a member of this group.')).toBeVisible();
  await expect(island.getByRole('link', { name: 'Open the signing page' })).toHaveAttribute('href', `/groups/sign/${ACTION}/`);

  // The queue with Bob's request. Picking it offers the policy update that lists Bob, at the
  // carried ratio of the current 2 of 3: 3 of 4.
  const queue = island.getByRole('region', { name: 'Requests to join' });
  await expect(queue.getByRole('checkbox', { name: 'E2E Applicant Bob' })).toBeVisible();
  await queue.getByRole('checkbox', { name: 'E2E Applicant Bob' }).check();
  await expect(queue.getByText('Also update the management policy in the same transaction')).toBeVisible();
  for (const name of ['E2E Wallet DRep', 'E2E Admin Alice', 'E2E Admin Erin', 'E2E Applicant Bob']) {
    await expect(queue.getByRole('checkbox', { name, exact: true }).last()).toBeChecked();
  }
  await expect(queue.getByText('3 of 4 must sign (75%)')).toBeVisible();
  await expect(queue.getByText('Each newly listed admin has to sign the update: E2E Applicant Bob.')).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Approve' })).toBeEnabled();
  await shot(page, '3a-admin-queue-combined-offer');

  // The policy editor.
  await queue.getByRole('checkbox', { name: 'E2E Applicant Bob' }).first().uncheck();
  await island.getByRole('button', { name: 'Manage the group' }).click();
  const editor = island.getByRole('region', { name: 'Manage the group' });
  await editor.getByRole('button', { name: 'Change admins or threshold' }).click();
  await expect(editor.getByRole('heading', { name: 'Update the management policy' })).toBeVisible();
  await expect(editor.getByText('2 of 3 must sign (67%)')).toBeVisible();
  await expect(editor.getByLabel('Add an admin by DRep id')).toBeVisible();
  await shot(page, '3b-admin-policy-editor');

  // Dissolving needs an explicit confirmation.
  await editor.getByRole('button', { name: 'Dissolve the group' }).click();
  await expect(editor.getByText('This cannot be undone. Members\' delegations do not change.')).toBeVisible();
  const confirm = editor.getByRole('checkbox', { name: 'Yes, dissolve this group' });
  await expect(confirm).not.toBeChecked();
  await expect(editor.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await confirm.check();
  await expect(editor.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await shot(page, '3c-admin-dissolve-confirmation');
  expect(await wallet.calls('signTx')).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('the signing page shows the lines, the signers and the cancel warning', async ({ page, wallet, koios }) => {
  await signInAsSeededDrep(page, koios, wallet.drepId);
  const errors = pageErrors(page);
  await page.goto(`/groups/sign/${ACTION}/`);
  await waitForHydration(page);
  const what = page.getByRole('region', { name: 'What this transaction does' });
  await expect(what.getByRole('listitem')).toHaveText(['Approve E2E Applicant Bob']);
  const signatures = page.getByRole('region', { name: 'Signatures' });
  await expect(signatures.getByText(`${shortKey(WALLET_KEY)} (waiting)`)).toBeVisible();
  await expect(signatures.getByText(`${shortKey(ALICE.hash)} (signed)`)).toBeVisible();
  await expect(signatures.getByText('May sign, already signed')).toBeVisible();
  await expect(signatures.getByText(`${shortKey(ERIN.hash)} (signed)`)).toBeVisible();
  await expect(signatures.getByText('More signatures are needed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign with wallet' })).toBeVisible();
  const cancel = page.getByRole('region', { name: 'Cancel' });
  await expect(cancel).toContainText('Cancelling stops this link for everyone.');
  await expect(cancel.getByRole('button', { name: 'Cancel this signing link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit transaction' })).toHaveCount(0);
  await shot(page, '4-signing-page');
  expect(errors).toEqual([]);
});

test('the notifications inbox leads to the join request and the signature request', async ({ page, wallet, koios }) => {
  await signInAsSeededDrep(page, koios, wallet.drepId);
  const errors = pageErrors(page);
  await page.goto('/notifications/');
  await waitForHydration(page);
  const join = page.getByRole('link', { name: `E2E Applicant Bob asked to join ${GROUP_NAME}` });
  await expect(join).toBeVisible();
  await expect(join).toHaveAttribute('href', `/groups/${GROUP}/#requests`);
  const sign = page.getByRole('link', { name: 'Someone asked you to sign: Approve E2E Applicant Bob' });
  await expect(sign).toBeVisible();
  await expect(sign).toHaveAttribute('href', `/groups/sign/${ACTION}/`);
  await shot(page, '5-notifications-inbox');
  expect(errors).toEqual([]);
});
