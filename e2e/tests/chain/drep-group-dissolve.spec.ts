// Chain-write tier, one group transaction on preprod: the account 0 DRep dissolves the throwaway
// group of the solo founding spec, managed 1 of 1 by its key. Afterwards the group page shows it as
// dissolved and offers no management any more.
import { expect, test } from 'cip30-test-wallet/playwright';
import { signIn, waitForHydration } from '../helpers.js';
import { APPLIED, buildAlone, CHAIN_TIMEOUT, chainGroup, chainWallet, resumeOr, untilVisible } from './groups.js';

test.use({ walletOptions: chainWallet(0) });

test('the only admin dissolves a throwaway group', async ({ page }) => {
  test.setTimeout(CHAIN_TIMEOUT);
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
  const groupPage = `/groups/${chainGroup('solo').id}/`;

  const actionId = await resumeOr(async () => {
    await page.goto(groupPage);
    await waitForHydration(page);
    await expect(page.locator('.drep-hd__status')).not.toContainText('Dissolved');
    const island = page.locator('#requests');
    await island.getByRole('button', { name: 'Manage the group' }).click();
    const editor = island.getByRole('region', { name: 'Manage the group' });
    await editor.getByRole('button', { name: 'Dissolve the group' }).click();
    await editor.getByRole('checkbox', { name: 'Yes, dissolve this group' }).check();
    await editor.getByRole('button', { name: 'Review and sign' }).click();
    return (await buildAlone(page, 'Dissolve the group')).actionId;
  });

  await untilVisible(page, `/groups/sign/${actionId}/`, (p) => p.getByText(APPLIED), 'dissolve applied');
  await page.goto(groupPage);
  await waitForHydration(page);
  await expect(page.locator('.drep-hd__status')).toContainText('Dissolved');
  await expect(page.locator('#requests').getByRole('button', { name: 'Manage the group' })).toHaveCount(0);
});
