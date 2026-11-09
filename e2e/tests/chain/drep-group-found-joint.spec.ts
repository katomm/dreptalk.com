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
  expectUnlistedButLinked,
  foundingName,
  groupIdOfAction,
  nextActionId,
  PNG,
  resumeOr,
  saveGroup,
  signedInAccount,
  signOnSigningPage,
  submitIfCollected,
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
  const name = foundingName('joint');

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
    await page.getByLabel('Name').fill(name);
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
    saveGroup('joint', { actionId: id });
    await expect(page.getByText('Share this signing link with the other signers')).toBeVisible();

    // Each co-founder finds the request in the inbox and signs through its link.
    for (const other of [one, two]) {
      await other.page.goto('/notifications/');
      await waitForHydration(other.page);
      // Earlier runs left older requests in the inbox, so the link is found by its target.
      const request = other.page.locator(`a[href="/groups/sign/${id}/"]`).filter({ hasText: / asked you to sign/ });
      await expect(request).toBeVisible();
      await request.click();
      await other.page.waitForURL(`**/groups/sign/${id}/`);
      await signOnSigningPage(other.page, id, other.wallet.drepKeyHashHex);
    }
    await signOnSigningPage(page, id, wallet.drepKeyHashHex);
    await expect(page.getByRole('region', { name: 'Signatures' }).getByText('Waiting', { exact: true })).toHaveCount(0);
    const txHash = await submitOnSigningPage(page, id);
    console.log(`[e2e] joint founding ${txHash}`);
    return id;
  });
  await submitIfCollected(page, actionId);

  await untilVisible(page, `/groups/sign/${actionId}/`, (p) => p.getByText(APPLIED), 'founding applied');
  // Co-founders see the same verdict.
  await one.page.goto(`/groups/sign/${actionId}/`);
  await expect(one.page.getByText(APPLIED)).toBeVisible({ timeout: 30_000 });

  const groupId = await groupIdOfAction(page, actionId);
  console.log(`[e2e] group ${groupId}`);
  saveGroup('joint', { id: groupId });
  // The group page names the group by its profile, so the profile was fetched and verified.
  await untilVisible(page, `/groups/${groupId}/`, (p) => p.getByRole('heading', { level: 1, name }), 'profile on the group page');
  await expect(page.getByText(DESCRIPTION)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members (3)' })).toBeVisible();
  await expect(page.getByText('Permissioned, confirmed by the group').first()).toBeVisible();
  // The founders count toward their older group, so the group list leaves this one out.
  await expectUnlistedButLinked(page, groupId, wallet.drepId);
});
