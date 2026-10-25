import { expect, test as walletTest, type WalletHandle } from 'cip30-test-wallet/playwright';
import type { Scenario } from '../koios-fixture/server.js';

export { expect, expectSignedBy, expectSignedData } from 'cip30-test-wallet/playwright';

export const KOIOS_CONTROL = `http://127.0.0.1:${process.env.E2E_KOIOS_PORT ?? 4399}/__fixture`;

// Hosts a mock run must never reach from the browser: the real chain APIs and
// the IPFS pinning service. Anything the app sends there in a mock run would
// mean a real read, or worse a real submit or pin.
const FORBIDDEN_HOSTS = /(^|\.)(koios\.rest|blockfrost\.io|pinata\.cloud|maestro\.org)$/;

export interface KoiosFixture {
  /** Replaces the fixture server's scenario for this test. */
  set(scenario: Scenario): Promise<void>;
  /** A scenario where the wallet's stake key is registered, undelegated, and its outputs are on chain. */
  setRegisteredWallet(wallet: WalletHandle): Promise<void>;
}

export const test = walletTest.extend<{ koios: KoiosFixture }>({
  // One rate-limit bucket per test, see the config.
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    await use({ ...extraHTTPHeaders, 'cf-connecting-ip': `e2e-${testInfo.testId}-${Date.now()}` });
  },
  koios: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      page.on('request', (request) => {
        const { hostname } = new URL(request.url());
        if (FORBIDDEN_HOSTS.test(hostname)) forbidden.push(request.url());
      });
      await post('scenario', {});
      await use({
        set: (scenario) => post('scenario', scenario),
        setRegisteredWallet: async (wallet) =>
          post('scenario', {
            accounts: { [wallet.addresses.reward]: { status: 'registered' } },
            utxos: (await wallet.utxos()).map((u) => ({
              address: wallet.addresses.payment,
              txHash: u.txId,
              index: u.index,
              lovelace: String(u.lovelace),
            })),
          } satisfies Scenario),
      });
      // A fail-soft caller swallows the 501 of a missing fixture, so the test
      // only notices through this list.
      const misses = (await (await fetch(`${KOIOS_CONTROL}/misses`)).json()) as unknown[];
      expect(misses, 'Koios requests without a fixture answer').toEqual([]);
      expect(forbidden, 'browser requests to a real chain or pinning API').toEqual([]);
    },
    { auto: true },
  ],
});

async function post(action: string, body: unknown): Promise<void> {
  const res = await fetch(`${KOIOS_CONTROL}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`koios fixture ${action} answered ${res.status}`);
}
