import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn, waitForHydration } from './helpers.js';

// The permissioned group of e2e/seed.sql, managed 2 of 3 by the test wallet's DRep key, Alice and
// Erin, with Bob's request pending and an approval of it collecting signatures.
const GROUP = 'drep_group1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq8zuq9qq43v6lk';
// The same group in the 34 byte id form it had before the one byte index. The seeded approval row
// is stored under it, and links in that form move to the canonical URL.
const GROUP_OLD = 'drep_group1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq8zuq9qqqqc2ldj9';
const GROUP_NAME = 'E2E Permissioned Council';
const ACTION = 'e2e00000000000000000000000000a01';
const SEEDED_DREP = 'drep1y2jmg4g450lced7q9n34rq6d5vjwkm0ugx6h0894u6ur92s9txn3a';
const ALICE = { drepId: 'drep1ygxk54m7j3q6mrkevcunryrwf4p7e68c93cjk8gzxkhlkps6qcwph', hash: '0d6a577e9441ad8ed9663931906e4d43ece8f82c712b1d0235affb06' };
const ERIN = { drepId: 'drep1yt74jw0m2cq7tdq7aenxmws5cznaz5w5ekdsu9nfrn36nfqv4qv3r', hash: 'fd5939fb5601e5b41eee666dba14c0a7d151d4cd9b0e16691ce3a9a4' };
const CAROL = 'drep1y29ftj8dtzpsd65gsc94f6cvvhnhm74en9ufe30xegqg0xg9gts5g';
// A 1 by 1 PNG for the required profile image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

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
  // The create button reads the same for everyone, an anonymous visitor signs in first and returns to the wizard.
  const create = page.getByRole('link', { name: 'Create group', exact: true }).first();
  await expect(create).toBeVisible();
  await expect(create).toHaveAttribute('href', '/login/?next=%2Fgroups%2Fnew%2F');
  await expect(page.locator('.gr-row .drep-table__rank').first()).toHaveText('#1');
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
  // Name, description and image are required, the step refuses to go on without them.
  await page.getByLabel('Name').fill('E2E Solo Group');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Add a description.')).toBeVisible();
  await page.getByLabel('Description').fill('E2E DReps who vote together.');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Add an image.')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: 'group.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('button', { name: 'Change image' })).toBeVisible();
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
  // The old id form answers with a permanent redirect to the canonical URL.
  const old = await page.request.get(`/groups/${GROUP_OLD}/`, { maxRedirects: 0 });
  expect(old.status()).toBe(301);
  expect(new URL(old.headers().location ?? '', 'http://x').pathname).toBe(`/groups/${GROUP}/`);
  await page.goto(`/groups/${GROUP_OLD}/`);
  await page.waitForURL(`**/groups/${GROUP}/`);
  await waitForHydration(page);
  const island = page.locator('#requests');
  await expect(island.getByRole('heading', { name: 'You are a member of this group' })).toBeVisible();
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

  // Removing an active member asks first and names them, the admin's own membership is not listed.
  const members = island.getByRole('region', { name: 'Remove members' });
  await expect(members.getByRole('button', { name: 'Remove E2E Wallet DRep' })).toHaveCount(0);
  await members.getByRole('button', { name: 'Remove E2E Admin Erin' }).click();
  await expect(members.getByText('Remove E2E Admin Erin from the group? Their delegations do not change.')).toBeVisible();
  await shot(page, '3a2-admin-remove-member');
  await members.getByRole('button', { name: 'Cancel' }).click();
  await expect(members.getByText(/from the group\?/)).toHaveCount(0);

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
  await expect(editor.getByRole('button', { name: 'Review and sign' })).toBeDisabled();
  await confirm.check();
  await expect(editor.getByRole('button', { name: 'Review and sign' })).toBeEnabled();
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
  await expect(what.getByRole('listitem')).toHaveText(['Approve E2E Applicant Bob as a member.']);
  const signatures = page.getByRole('region', { name: 'Signatures' });
  // Signers are named by their DRep name with their state.
  const signer = (name: string) => signatures.getByRole('listitem').filter({ hasText: name });
  await expect(signer('E2E Wallet DRep')).toContainText('Waiting');
  await expect(signer('E2E Admin Alice')).toContainText('Signed');
  await expect(signatures.getByText('May sign, already signed')).toBeVisible();
  await expect(signer('E2E Admin Erin')).toContainText('Signed');
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
  const sign = page.getByRole('link', { name: `Someone asked you to sign for ${GROUP_NAME}: Approve E2E Applicant Bob` });
  await expect(sign).toBeVisible();
  await expect(sign).toHaveAttribute('href', `/groups/sign/${ACTION}/`);
  await shot(page, '5-notifications-inbox');
  expect(errors).toEqual([]);
});
