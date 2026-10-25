import { expect, expectSignedBy, test } from './fixtures.js';
import { freshAccountIndex, isVerify, waitForHydration } from './helpers.js';

// The DRep from e2e/seed.sql.
const DREP = { slug: 'e2e-test-drep', name: 'E2E Test DRep' };

// The follow-up login creates an account.
test.use({ walletOptions: { accountIndex: freshAccountIndex() } });

test('a visitor delegates to a DRep, follows it, and sees the delegation on the dashboard', async ({ page, wallet, koios }) => {
  // The stake key is registered and not yet delegated: the dialog's
  // registration check passes, and the dashboard's chain lookup does not
  // already show the delegation, so the pending expectation stays visible.
  await koios.setRegisteredWallet(wallet);

  await page.goto(`/dreps/${DREP.slug}/`);
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Delegate voting power' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delegate voting power' });
  await dialog.getByRole('button', { name: 'Connect wallet' }).click();
  await dialog.getByRole('button', { name: 'Delegate to this DRep' }).click();
  await expect(dialog.getByText('Delegation submitted')).toBeVisible();

  // The journal belongs to this page, and the follow-up login reloads it.
  const tx = await wallet.lastSubmittedTx();
  expect(tx).toBeDefined();
  expectSignedBy(tx!, wallet, { roles: ['payment', 'stake'] });

  // The session cookie comes with the verify answer, the dialog's own reload
  // after it is not needed.
  const verify = page.waitForResponse(isVerify);
  await dialog.getByRole('button', { name: 'Follow how this DRep votes' }).click();
  expect((await verify).status()).toBe(200);
  await page.goto('/my-drep/');
  await expect(page.getByRole('status').filter({ hasText: 'is being confirmed on chain' })).toContainText(DREP.name);
});
