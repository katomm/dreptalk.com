// Chain-write tier, one group transaction on preprod: an admin of the 2 of 3 group approves the
// pending request of the account 3 DRep together with the proposed update of the management policy
// to the new members, 3 of 4. A second admin and the new admin, whose consent the update needs,
// sign through the signing link. Runs after the join request spec.
import { expect, test } from 'cip30-test-wallet/playwright';
import { signIn, waitForHydration } from '../helpers.js';
import {
  APPLIED,
  CHAIN_TIMEOUT,
  chainWallet,
  groupIdByName,
  JOINT_GROUP,
  nextActionId,
  resumeOr,
  shortKey,
  signedInAccount,
  signOnSigningPage,
  submitOnSigningPage,
  untilVisible,
} from './groups.js';

test.use({ walletOptions: chainWallet(0) });

test('admins approve a request together with the proposed policy update', async ({ page, wallet, browser }, testInfo) => {
  test.setTimeout(CHAIN_TIMEOUT);
  const others = await Promise.all([1, 2, 3].map((n) => signedInAccount(browser, testInfo, n)));
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
  const groupId = await groupIdByName(page, JOINT_GROUP);
  const groupPage = `/groups/${groupId}/`;

  const actionId = await resumeOr(async () => {
    await page.goto(groupPage);
    await waitForHydration(page);
    const queue = page.locator('#requests').getByRole('region', { name: 'Requests to join' });
    await queue.getByRole('checkbox').first().check();
    // The offer lists the new member at the carried ratio of 2 of 3.
    await expect(queue.getByText('Also update the management policy in the same transaction')).toBeVisible();
    await expect(queue.getByText('3 of 4 must sign (75%)')).toBeVisible();
    await expect(queue.getByText(/^Each newly listed admin has to sign the update:/)).toBeVisible();
    await queue.getByRole('button', { name: 'Approve' }).click();

    const draft = page.getByRole('region', { name: 'Approve' });
    await expect(draft.getByRole('button', { name: 'Build and sign' })).toBeEnabled();
    const opened = nextActionId(page);
    await draft.getByRole('button', { name: 'Build and sign' }).click();
    const id = await opened;
    await expect(page.getByText('Share this signing link with the other signers')).toBeVisible();

    // Everyone whose key the signing page lists as waiting signs, the initiator last.
    await page.goto(`/groups/sign/${id}/`);
    await waitForHydration(page);
    const signatures = page.getByRole('region', { name: 'Signatures' });
    await expect(signatures).toBeVisible();
    const lines = await signatures.locator('li').allTextContents();
    console.log(`[e2e] signers: ${lines.join(' | ')}`);
    const waiting = (key: string) => lines.some((l) => l.includes(`${shortKey(key)} (waiting)`));
    const signers = [...others.filter((o) => waiting(o.wallet.drepKeyHashHex)), ...(waiting(wallet.drepKeyHashHex) ? [{ page, wallet }] : [])];
    expect(signers.map((s) => s.wallet.drepKeyHashHex), 'the new admin consents').toContain(others[2].wallet.drepKeyHashHex);
    for (const s of signers) {
      if (s.page !== page) {
        await s.page.goto('/notifications/');
        await waitForHydration(s.page);
        await expect(s.page.getByRole('link', { name: /^Someone asked you to sign:/ }).first()).toHaveAttribute('href', `/groups/sign/${id}/`);
      }
      await signOnSigningPage(s.page, id, s.wallet.drepKeyHashHex);
    }
    await page.goto(`/groups/sign/${id}/`);
    await expect(page.getByText('Every required signature is collected.')).toBeVisible({ timeout: 30_000 });
    await submitOnSigningPage(page, id);
    return id;
  });

  await untilVisible(page, `/groups/sign/${actionId}/`, (p) => p.getByText(APPLIED), 'admission applied');
  await page.goto(groupPage);
  await waitForHydration(page);
  await expect(page.getByRole('heading', { name: 'Members (4)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requests (1)' })).toHaveCount(0);
  // The new member sees the membership.
  const newcomer = others[2].page;
  await newcomer.goto(groupPage);
  await waitForHydration(newcomer);
  await expect(newcomer.getByRole('region', { name: 'Your membership' }).getByText('You are a member of this group.')).toBeVisible();
});
