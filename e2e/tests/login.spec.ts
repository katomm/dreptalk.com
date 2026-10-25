import { expect, expectSignedData, test } from './fixtures.js';
import { isVerify, signIn, verifyAnswer } from './helpers.js';

type Sig = { signature: string; key: string };

test('a delegator signs in with the reward address @both-engines', async ({ page, wallet }) => {
  // DRepTalk navigates to /home/ after a successful login, and the new document
  // starts with a fresh journal. Hold the verify request until the signature is
  // copied out, then let it through. signData has finished by then, verify is
  // only sent after the wallet answered.
  type Entries = Awaited<ReturnType<typeof wallet.calls>>;
  let signed: Entries = [];
  let rewards: Entries = [];
  await page.route('**/api/auth/verify', async (route) => {
    signed = await wallet.calls('signData');
    rewards = await wallet.calls('getRewardAddresses');
    await route.continue();
  });
  const verify = page.waitForResponse(isVerify);
  await signIn(page, 'delegator');
  expect((await verify).status()).toBe(200);
  await page.waitForURL('**/home/');
  expect(signed).toHaveLength(1);
  const [reward] = rewards[0]!.result as string[];
  expect(signed[0]!.args[0]).toBe(reward);
  expectSignedData(signed[0]!.result as Sig, { payload: signed[0]!.args[1] as string, address: reward!, publicKeyHex: wallet.stakePublicKeyHex });
});

test.describe('declined message', () => {
  test.use({ walletOptions: { quirks: { signDataRejected: true } } });
  test('the delegator login shows an error and never reaches verify', async ({ page, wallet }) => {
    let verified = false;
    page.on('request', (r) => {
      if (isVerify(r)) verified = true;
    });
    await signIn(page, 'delegator');
    await expect(page.locator('.callout--error[role="alert"]')).toBeVisible();
    expect(await wallet.calls('signData')).toHaveLength(1);
    expect(verified).toBe(false);
  });
});

test('a registered DRep signs in with the DRep key', async ({ page, wallet, koios }) => {
  await koios.set({ activeDreps: [wallet.drepId] });
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
});

test('a DRep signs with the bare DRep ID, DRepTalk accepts the signature and asks the chain', async ({ page, wallet }) => {
  // The scenario marks no DRep active, so the signature is valid and the role check fails.
  const answer = await verifyAnswer(page, 'drep');
  expect(answer).toEqual({ status: 401, error: 'not an active DRep' });
  const calls = await wallet.calls('cip95.signData');
  expect(calls.map((c) => c.args[0])).toEqual([wallet.drepKeyHashHex]);
  expectSignedData(calls[0]!.result as Sig, { payload: calls[0]!.args[1] as string, address: wallet.drepKeyHashHex, publicKeyHex: wallet.drepPublicKeyHex });
});

test.describe('wallet that signs only the type 6 form', () => {
  test.use({ walletOptions: { quirks: { cip95SignData: 'type6Only' } } });
  test('DRepTalk falls back to the type 6 address and still gets a valid signature', async ({ page, wallet }) => {
    const answer = await verifyAnswer(page, 'drep');
    expect(answer.error).toBe('not an active DRep');
    const calls = await wallet.calls('cip95.signData');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.error).toMatchObject({ code: 1 });
    expect(calls[1]!.args[0]).toBe(`60${wallet.drepKeyHashHex}`);
  });
});

test.describe('wallet that writes the bare hash into the COSE header', () => {
  test.use({ walletOptions: { quirks: { cip95SignData: 'type6Only', coseAddress: 'bareKeyHash' } } });
  test('DRepTalk accepts the bare header for a type 6 request', async ({ page }) => {
    const answer = await verifyAnswer(page, 'drep');
    expect(answer.error).toBe('not an active DRep');
  });
});

for (const quirk of ['noCip95', 'cip95NamespaceMissing'] as const) {
  test.describe(`wallet with ${quirk}`, () => {
    test.use({ walletOptions: { quirks: { [quirk]: true } } });
    test('the DRep login explains the missing CIP-95 support and signs nothing', async ({ page, wallet }) => {
      await signIn(page, 'drep');
      await expect(page.locator('.callout--error[role="alert"]')).toContainText(/CIP-95/i);
      expect(await wallet.calls('cip95.signData')).toHaveLength(0);
      expect(await wallet.calls('signData')).toHaveLength(0);
    });
  });
}
