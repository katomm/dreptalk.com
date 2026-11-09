// Chain-write tier, one group transaction on preprod: the account 0 DRep founds a throwaway group
// alone through the wizard, the engine judges the founding, and the group page shows the hosted
// profile. The dissolve spec ends this group again. See groups.ts for the gov-sync setup.
import { expect, test } from 'cip30-test-wallet/playwright';
import { signIn, waitForHydration } from '../helpers.js';
import {
  APPLIED,
  buildAlone,
  CHAIN_TIMEOUT,
  CONFIRMING,
  chainWallet,
  expectUnlistedButLinked,
  foundingName,
  groupIdOfAction,
  PNG,
  RESUMED,
  resumeOr,
  saveGroup,
  untilVisible,
} from './groups.js';

const DESCRIPTION = 'Throwaway preprod test group of the DRepTalk end to end suite, dissolved after the test.';

test.use({ walletOptions: chainWallet(0) });

test('a DRep founds a group alone and the group page shows its profile', async ({ page, wallet }) => {
  test.setTimeout(CHAIN_TIMEOUT);
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
  const name = foundingName('solo');

  const actionId = await resumeOr(async () => {
    await page.goto('/groups/new/');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('radio', { name: 'Found alone' })).toBeChecked();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('1 of 1 must sign (100%)')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Description').fill(DESCRIPTION);
    await page.locator('input[type="file"]').setInputFiles({ name: 'group.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('button', { name: 'Change image' })).toBeVisible();

    const profile = page.waitForResponse((r) => r.url().endsWith('/api/groups/profile'));
    await page.getByRole('button', { name: 'Next' }).click();
    const anchor = (await (await profile).json()) as { url: string; hash: string };
    console.log(`[e2e] profile anchor ${anchor.url}`);

    const review = page.getByRole('region', { name: 'Found the group' });
    await expect(review.getByText('You found the group alone and sign it in one wallet step.')).toBeVisible();
    const { actionId: id } = await buildAlone(page, 'Found the group');
    saveGroup('solo', { actionId: id });
    return id;
  });

  if (!RESUMED) {
    await page.goto(`/groups/sign/${actionId}/`);
    await expect(page.getByText(CONFIRMING)).toBeVisible({ timeout: 30_000 });
  }
  await untilVisible(page, `/groups/sign/${actionId}/`, (p) => p.getByText(APPLIED), 'founding applied');

  // The group page names the group by its profile, so the profile was fetched and verified.
  const groupId = await groupIdOfAction(page, actionId);
  console.log(`[e2e] group ${groupId}`);
  saveGroup('solo', { id: groupId });
  await untilVisible(page, `/groups/${groupId}/`, (p) => p.getByRole('heading', { level: 1, name }), 'profile on the group page');
  await expect(page.getByText(DESCRIPTION)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members (1)' })).toBeVisible();
  // Account 0 counts toward its older joint group, so the group list leaves this one out.
  await expectUnlistedButLinked(page, groupId, wallet.drepId);
});
