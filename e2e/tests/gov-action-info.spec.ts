import { RewardAccount, Transaction } from '@evolution-sdk/evolution';
import epochParams from '../koios-fixture/epoch-params.json' with { type: 'json' };
import { expect, expectSignedBy, test } from './fixtures.js';
import { freshAccountIndex, signIn, waitForHydration } from './helpers.js';

// The anchor the stubbed pinning step answers with. The test never pins
// anything, it only checks that the signed proposal carries this anchor.
const ANCHOR = {
  anchorUrl: 'ipfs://bafkreie2etestanchornotpinnedanywhere000000000000000000000',
  anchorHash: 'e2e0'.repeat(16),
};

// Enough for the 1,000 tADA preprod deposit plus fees and change.
test.use({ walletOptions: { accountIndex: freshAccountIndex(), utxos: [{ lovelace: 1_010_000_000n }] } });

test('a signed-in user submits an info action, signed with the anchor and deposit', async ({ page, wallet, koios }) => {
  await koios.setRegisteredWallet(wallet);

  // Pinning would upload to IPFS, the test answers in its place.
  let pinned: Record<string, unknown> | undefined;
  await page.route('**/api/gov-action/metadata', async (route) => {
    pinned = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: ANCHOR });
  });

  await signIn(page, 'delegator');
  await page.waitForURL('**/home/', { waitUntil: 'commit' });
  await page.goto('/ga/new/');
  await waitForHydration(page);

  await page.getByRole('radio', { name: /Info action/ }).check();
  await page.getByLabel('Title').fill('E2E info action');
  await page.getByLabel('Abstract').fill('Submitted by the end-to-end tests against a fixture chain.');
  await page.getByLabel('Motivation').fill('Covers the submit flow from the form to the signed transaction.');
  await page.getByLabel('Rationale').fill('Nothing reaches a real chain.');

  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByText(/^Deposit .*wallet/)).toBeVisible();
  await page.getByRole('button', { name: 'Review and submit' }).click();
  await page.getByRole('button', { name: 'Sign and submit' }).click();
  // Builds, signs and submits the transaction in the browser, which takes
  // well over the default 5 s on a CI runner.
  await expect(page.getByRole('status').filter({ hasText: 'Proposal submitted' })).toBeVisible({ timeout: 30_000 });

  // "Sign as author" is on by default: the finalize request carries the witness.
  expect(pinned?.author).toMatchObject({ name: expect.any(String), keyHex: expect.any(String), signatureHex: expect.any(String) });

  const tx = await wallet.lastSubmittedTx();
  expect(tx).toBeDefined();
  expectSignedBy(tx!, wallet, { roles: ['payment'] });

  const [proposal, ...more] = Transaction.fromCBORHex(tx!).body.proposalProcedures?.procedures ?? [];
  expect(more).toHaveLength(0);
  expect(proposal?.governanceAction._tag).toBe('InfoAction');
  expect(String(proposal?.deposit)).toBe(String(epochParams.gov_action_deposit));
  expect(proposal?.anchor?.anchorUrl.href).toBe(ANCHOR.anchorUrl);
  expect(Buffer.from(proposal?.anchor?.anchorDataHash ?? []).toString('hex')).toBe(ANCHOR.anchorHash);
  // The deposit returns to the wallet's own reward account.
  expect(RewardAccount.toBech32(proposal!.rewardAccount)).toBe(wallet.addresses.reward);
});
