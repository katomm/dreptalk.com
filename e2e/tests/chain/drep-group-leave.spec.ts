// Chain-write tier, one group transaction on preprod: the account 3 DRep, admitted by the admission
// spec, leaves the 2 of 3 group on its own signature. Afterwards the group has three members again.
import { expect, test } from 'cip30-test-wallet/playwright';
import { signIn, waitForHydration } from '../helpers.js';
import { APPLIED, buildAlone, CHAIN_TIMEOUT, chainWallet, groupIdByName, JOINT_GROUP, resumeOr, untilVisible } from './groups.js';

test.use({ walletOptions: chainWallet(3) });

test('a member leaves a group alone', async ({ page }) => {
  test.setTimeout(CHAIN_TIMEOUT);
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
  const groupId = await groupIdByName(page, JOINT_GROUP);
  const groupPage = `/groups/${groupId}/`;

  const actionId = await resumeOr(async () => {
    await page.goto(groupPage);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: 'Members (4)' })).toBeVisible();
    // The admission updated the management policy to the four members.
    await expect(page.locator('dt', { hasText: 'Management' }).locator('xpath=following-sibling::dd[1]')).toHaveText(/^3 of 4: /);
    const membership = page.getByRole('region', { name: 'Your membership' });
    await expect(membership.getByRole('heading', { name: 'You are a member of this group' })).toBeVisible();
    await membership.getByRole('button', { name: 'Leave' }).click();
    return (await buildAlone(page, 'Leave the group')).actionId;
  });

  await untilVisible(page, `/groups/sign/${actionId}/`, (p) => p.getByText(APPLIED), 'leave applied');
  await page.goto(groupPage);
  await waitForHydration(page);
  await expect(page.getByRole('heading', { name: 'Members (3)' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your membership' }).getByRole('button', { name: 'Request to join' })).toBeVisible();
});
