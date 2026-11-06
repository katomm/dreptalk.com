// Chain-write tier, one group transaction on preprod: the account 3 DRep of the test seed asks to
// join the 2 of 3 group of the joint founding spec. Once the engine has the request, it is pending
// on the group page and the admins find it in their inbox. The admission spec approves it.
import { expect, test } from 'cip30-test-wallet/playwright';
import { signIn, waitForHydration } from '../helpers.js';
import { APPLIED, buildAlone, CHAIN_TIMEOUT, chainGroup, chainWallet, resumeOr, signedInAccount, untilVisible } from './groups.js';

test.use({ walletOptions: chainWallet(3) });

test('a DRep asks to join a permissioned group and the admins are told', async ({ page, browser }, testInfo) => {
  test.setTimeout(CHAIN_TIMEOUT);
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
  const groupPage = `/groups/${chainGroup('joint').id}/`;

  const actionId = await resumeOr(async () => {
    await page.goto(groupPage);
    await waitForHydration(page);
    await page.getByRole('region', { name: 'Your membership' }).getByRole('button', { name: 'Request to join' }).click();
    return (await buildAlone(page, 'Request to join')).actionId;
  });

  await untilVisible(page, `/groups/sign/${actionId}/`, (p) => p.getByText(APPLIED), 'join request applied');
  await page.goto(groupPage);
  await waitForHydration(page);
  await expect(page.getByRole('heading', { name: 'Requests (1)' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your membership' }).getByRole('heading', { name: 'Your request to join is pending' })).toBeVisible();

  // The join notifications are written by the tick after the request, so the admins may need one more.
  const admin = await signedInAccount(browser, testInfo, 0);
  // Earlier runs left older join requests in the inbox, so the link is found by its target.
  await untilVisible(
    admin.page,
    '/notifications/',
    (p) => p.locator(`a[href="${groupPage}#requests"]`).filter({ hasText: /asked to join / }),
    'join request in the admin inbox',
  );
});
