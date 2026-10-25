// Chain-read tier: DREPTALK_E2E_CHAIN=read with PREPROD_TEST_WALLET_MNEMONIC,
// the mnemonic of a wallet whose account 0 DRep key is registered on preprod.
// The dev server resolves the DRep against real preprod Koios. Nothing is
// submitted.
import { test } from 'cip30-test-wallet/playwright';
import { signIn } from '../helpers.js';

test.use({ walletOptions: { mnemonic: process.env.PREPROD_TEST_WALLET_MNEMONIC } });

test('a DRep registered on preprod signs in', async ({ page }) => {
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
});
