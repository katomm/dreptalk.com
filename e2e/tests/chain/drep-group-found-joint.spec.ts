// Chain-write tier, one group transaction on preprod: the DReps of accounts 0, 1 and 2 of the test
// seed found a permissioned group managed 2 of 3. Account 0 opens the founding, accounts 1 and 2
// get the signature request in their inbox and sign through the signing link from browser
// contexts of their own, account 0 signs and submits. The admission and leave specs build on this
// group. See groups.ts for the gov-sync setup.
import { expect, test } from 'cip30-test-wallet/playwright';
import { signIn, waitForHydration } from '../helpers.js';
import {
  APPLIED,
  CHAIN_TIMEOUT,
  chainWallet,
  JOINT_GROUP,
  nextActionId,
  PNG,
  resumeOr,
  signedInAccount,
  signOnSigningPage,
  submitOnSigningPage,
  untilVisible,
} from './groups.js';

const DESCRIPTION = 'Preprod test group of the DRepTalk end to end suite, founded by three test DReps of one seed.';

test.use({ walletOptions: chainWallet(0) });

test('three DReps found a 2 of 3 group through the signing link', async ({ page, wallet, browser }, testInfo) => {
  test.setTimeout(CHAIN_TIMEOUT);
  // The co-founders sign in first, so their accounts exist when the founding notifies its signers.
  const one = await signedInAccount(browser, testInfo, 1);
  const two = await signedInAccount(browser, testInfo, 2);
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');

  const actionId = await resumeOr(async () => {
    await page.goto('/groups/new/');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('radio', { name: 'Found together with other DReps' }).check();
    for (const other of [one, two]) {
      await page.getByLabel('Add a founder by DRep id').fill(other.wallet.drepId);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByLabel('Add a founder by DRep id')).toHaveValue('');
    }
    await page.getByRole('button', { name: 'Next' }).click();
    // Three founders default to a majority.
    await expect(page.getByText('2 of 3 must sign (67%)')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Name').fill(JOINT_GROUP);
    await page.getByLabel('Description').fill(DESCRIPTION);
    await page.locator('input[type="file"]').setInputFiles({ name: 'group.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('button', { name: 'Change image' })).toBeVisible();
    const profile = page.waitForResponse((r) => r.url().endsWith('/api/groups/profile'));
    await page.getByRole('button', { name: 'Next' }).click();
    console.log(`[e2e] profile anchor ${((await (await profile).json()) as { url: string }).url}`);

    const review = page.getByRole('region', { name: 'Found the group' });
    await expect(review.getByText('Management policy: 2 of 3 must sign')).toBeVisible();
    await expect(review.getByText('Every founder signs the founding transaction, also when the threshold is lower.')).toBeVisible();
    const opened = nextActionId(page);
    await review.getByRole('button', { name: 'Build and sign' }).click();
    const id = await opened;
    await expect(page.getByText('Share this signing link with the other signers')).toBeVisible();

    // Each co-founder finds the request in the inbox and signs through its link.
    for (const other of [one, two]) {
      await other.page.goto('/notifications/');
      await waitForHydration(other.page);
      const request = other.page.getByRole('link', { name: /^Someone asked you to sign:/ }).first();
      await expect(request).toHaveAttribute('href', `/groups/sign/${id}/`);
      await request.click();
      await other.page.waitForURL(`**/groups/sign/${id}/`);
      await signOnSigningPage(other.page, id, other.wallet.drepKeyHashHex);
    }
    await signOnSigningPage(page, id, wallet.drepKeyHashHex);
    await expect(page.getByRole('region', { name: 'Signatures' }).getByText('(waiting)')).toHaveCount(0);
    const txHash = await submitOnSigningPage(page, id);
    console.log(`[e2e] joint founding ${txHash}`);
    return id;
  });

  await untilVisible(page, `/groups/sign/${actionId}/`, (p) => p.getByText(APPLIED), 'founding applied');
  // Co-founders see the same verdict.
  await one.page.goto(`/groups/sign/${actionId}/`);
  await expect(one.page.getByText(APPLIED)).toBeVisible({ timeout: 30_000 });

  await untilVisible(page, '/groups/', (p) => p.getByRole('link', { name: JOINT_GROUP, exact: true }), 'profile on the group list');
  await page.getByRole('link', { name: JOINT_GROUP, exact: true }).first().click();
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: JOINT_GROUP })).toBeVisible();
  await expect(page.getByText(DESCRIPTION)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members (3)' })).toBeVisible();
  await expect(page.getByText('Permissioned, confirmed by the group').first()).toBeVisible();
  console.log(`[e2e] group page ${page.url()}`);
});
