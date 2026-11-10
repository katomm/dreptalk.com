// Chain-write tier, one group transaction on preprod: the account 1 DRep, an admin of the joint
// group since its founding, resigns as admin on its own signature. Its key stays in the policy
// script but counts as admin nowhere, and the group page lists it as resigned. Runs after the
// founding of the joint group or at the end of the order in groups.ts. The other admins still
// satisfy the policy then, so the resign never freezes the group, the spec checks that first.
import { expect, test } from 'cip30-test-wallet/playwright';
import { signIn, waitForHydration } from '../helpers.js';
import { APPLIED, buildAlone, CHAIN_TIMEOUT, chainGroup, chainWallet, resumeOr, untilVisible } from './groups.js';

test.use({ walletOptions: chainWallet(1) });

test('an admin resigns alone', async ({ page, wallet }) => {
  test.setTimeout(CHAIN_TIMEOUT);
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
  const groupPage = `/groups/${chainGroup('joint').id}/`;
  const role = (name: string) => page.locator('dt', { hasText: name }).locator('xpath=..');
  const management = role('Management');
  // The page names a DRep without a profile by its short id, like the signing page shortens keys.
  const ownLabel = `${wallet.drepId.slice(0, 8)}...${wallet.drepId.slice(-4)}`;

  const actionId = await resumeOr(async () => {
    await page.goto(groupPage);
    await waitForHydration(page);
    await expect(management.getByText('Resigned', { exact: true })).toHaveCount(0);
    const island = page.locator('#requests');
    await island.getByRole('button', { name: 'Manage the group' }).click();
    const editor = island.getByRole('region', { name: 'Manage the group' });
    await editor.getByRole('button', { name: 'Resign as admin' }).click();
    await expect(editor.getByText(/^Your key stops counting as admin/)).toBeVisible();
    // The other admins still satisfy the policy, so no freeze warning and no name to type.
    await expect(editor.getByText('Nobody will be able to change or dissolve this group after you resign.', { exact: false })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Review and sign' }).click();
    return (await buildAlone(page, 'Resign as admin')).actionId;
  });

  await untilVisible(page, `/groups/sign/${actionId}/`, (p) => p.getByText(APPLIED), 'resign applied');
  await page.goto(groupPage);
  await waitForHydration(page);
  // The key stays in both policies of the group and is listed again as resigned from each role.
  for (const name of ['Management', 'Admission']) {
    await expect(role(name).locator('dd', { hasText: 'Resigned' })).toHaveText(`Resigned ${ownLabel}`);
  }
  await expect(page.getByText(`${ownLabel} resigned as admin.`)).toBeVisible();
  // Still a member, without the Admin badge, and with nothing left to resign.
  const member = page.locator('li', { has: page.getByRole('link', { name: ownLabel, exact: true }) });
  await expect(member).toHaveCount(1);
  await expect(member.getByText('Admin', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Your membership' }).getByRole('heading', { name: 'You are a member of this group' })).toBeVisible();
  await expect(page.locator('#requests').getByRole('button', { name: 'Manage the group' })).toHaveCount(0);
  const shotDir = process.env.E2E_SCREENSHOT_DIR;
  if (shotDir) await page.screenshot({ path: `${shotDir}/resigned-admin-group-page.png`, fullPage: true });
});
