// Shared steps of the chain-write DRep group specs. Every spec submits one group transaction on
// preprod and waits until the engine of a local gov-sync worker has judged it. Before a run, start
// gov-sync on the same local D1 as the dev server, against preprod:
//
//   npx wrangler dev -c workers/gov-sync/wrangler.toml --var CARDANO_NETWORK:preprod \
//     --var TESSERA_BACKEND_URL:https://tessera-backend-preprod.matthieu-pizenberg.workers.dev \
//     --persist-to .wrangler/state --test-scheduled --port 8789
//
// The specs then fire its governance cron themselves (E2E_SYNC_URL overrides the address). The
// tick must run while the dev server is up, since the engine fetches the group profile from the
// anchor URL the dev server wrote, which is the dev server's own origin. On a fresh local D1, run
// the 6-hourly cron (`0 */6 * * *`) once and governance ticks until they are short, the first ones
// backfill preprod and leave the groups phase no queries.
//
// The specs build on each other, in this order: found-solo, found-joint, join-request, admit,
// leave, dissolve. Each takes one write run of its own (DREPTALK_E2E_CHAIN=write and the spec file).
import type { Browser, Page, TestInfo } from '@playwright/test';
import { attachWallet, expect, type WalletHandle } from 'cip30-test-wallet/playwright';
import { signIn, waitForHydration } from '../helpers.js';

const MNEMONIC = process.env.PREPROD_TEST_WALLET_MNEMONIC;

/** Wallet options of an account of the test seed, reading and submitting on preprod. */
export const chainWallet = (accountIndex: number) => ({
  mnemonic: MNEMONIC,
  accountIndex,
  ledger: { chain: { provider: 'koios' as const, network: 'preprod' as const } },
});

const SYNC_URL = process.env.E2E_SYNC_URL ?? 'http://127.0.0.1:8789';
/** The governance cron, which runs the drep-groups phase last. */
const GOVERNANCE_CRON = '*/5 * * * *';

/** A whole run waits for a submit, ten blocks of depth and the ticks that judge it. */
export const CHAIN_TIMEOUT = 30 * 60_000;

/** The signing page's line once the engine judged the transaction as applied. */
export const APPLIED = 'The transaction is confirmed and the group change is in effect.';
export const CONFIRMING = 'The transaction is submitted and waiting for the chain to confirm it.';

/** The throwaway group the solo founding creates and the dissolve ends. */
export const SOLO_GROUP = 'E2E test throwaway group (solo)';
/** The 2 of 3 group of accounts 0, 1 and 2, kept for the admission and the leave. */
export const JOINT_GROUP = 'E2E test joint group (2 of 3)';

/** A 1 by 1 PNG for the required profile image. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Runs one governance tick of the local gov-sync worker. A failed or slow tick is only logged. */
export async function tick(): Promise<void> {
  const started = Date.now();
  try {
    const res = await fetch(`${SYNC_URL}/__scheduled?cron=${encodeURIComponent(GOVERNANCE_CRON)}`);
    console.log(`[e2e] governance tick ${res.status} in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (err) {
    console.log(`[e2e] governance tick failed after ${Math.round((Date.now() - started) / 1000)} s: ${String(err)}`);
  }
}

/**
 * Reloads `url` until `find` shows something, with a governance tick between the tries. Each try
 * gives the page's islands time to load their data.
 */
export async function untilVisible(
  page: Page,
  url: string,
  find: (page: Page) => ReturnType<Page['getByText']>,
  label: string,
  timeoutMs = 25 * 60_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    await page.goto(url);
    await waitForHydration(page);
    const shown = await find(page)
      .first()
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    if (shown) {
      console.log(`[e2e] ${label} after ${Math.round((Date.now() - started) / 1000)} s`);
      return;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${label}: not shown within ${timeoutMs / 60_000} min`);
    await tick();
    await page.waitForTimeout(20_000);
  }
}

/** A page of its own for another account of the seed, signed in as that account's DRep. */
export async function signedInAccount(browser: Browser, testInfo: TestInfo, accountIndex: number): Promise<{ page: Page; wallet: WalletHandle }> {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    // Its own rate-limit bucket, see the config.
    extraHTTPHeaders: { 'cf-connecting-ip': `e2e-account-${accountIndex}-${Date.now()}` },
  });
  const page = await context.newPage();
  const wallet = await attachWallet(page, chainWallet(accountIndex));
  await signIn(page, 'drep');
  await page.waitForURL('**/home/');
  return { page, wallet };
}

/** Signs the action on its signing page with the page's wallet and checks the signature is listed. */
export async function signOnSigningPage(page: Page, actionId: string, keyHash: string): Promise<void> {
  await page.goto(`/groups/sign/${actionId}/`);
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Sign with wallet' }).click();
  const signatures = page.getByRole('region', { name: 'Signatures' });
  await expect(signatures.locator(`li[data-key="${keyHash}"]`)).toContainText('Signed', { timeout: 60_000 });
}

/**
 * Submits a fully signed action from its signing page, returns the tx hash and checks the page
 * shows it as confirming.
 */
export async function submitOnSigningPage(page: Page, actionId: string): Promise<string> {
  await page.goto(`/groups/sign/${actionId}/`);
  await waitForHydration(page);
  const recorded = page.waitForRequest((r) => r.url().endsWith(`/api/groups/actions/${actionId}/submitted`));
  await page.getByRole('button', { name: 'Submit transaction' }).click();
  const txHash = (JSON.parse((await recorded).postData() ?? '{}') as { txHash: string }).txHash;
  console.log(`[e2e] action ${actionId} submitted as ${txHash}`);
  await expect(page.getByText(CONFIRMING)).toBeVisible({ timeout: 60_000 });
  return txHash;
}

/** The id of the action the next POST /api/groups/actions opens. */
export function nextActionId(page: Page): Promise<string> {
  return page
    .waitForResponse((r) => r.url().endsWith('/api/groups/actions') && r.request().method() === 'POST', { timeout: 120_000 })
    .then(async (r) => {
      expect(r.status(), await r.text()).toBe(200);
      const { id } = (await r.json()) as { id: string };
      console.log(`[e2e] action opened: ${id}`);
      return id;
    });
}

/**
 * The id of a group found by its name: on the group list, which shows groups of two members or
 * more, or with `drepId` on the profile of a member DRep, which shows every group of that DRep.
 */
export async function groupIdByName(page: Page, name: string, drepId?: string): Promise<string> {
  await page.goto(drepId ? `/dreps/${drepId}/` : '/groups/');
  const link = drepId ? page.locator('a.drep-hd__group', { hasText: name }) : page.getByRole('link', { name, exact: true });
  const href = await link.first().getAttribute('href');
  const id = href?.match(/\/groups\/(group1[0-9a-z]+)\//)?.[1];
  if (!id) throw new Error(`no group named ${name}`);
  return id;
}

/**
 * Builds the drafted action in the panel `label` when the page's DRep is its only signer: the
 * wallet signs and submits in one step. Returns the action id and the tx hash.
 */
export async function buildAlone(page: Page, label: string): Promise<{ actionId: string; txHash: string }> {
  const panel = page.getByRole('region', { name: label });
  const opened = nextActionId(page);
  const recorded = page.waitForRequest((r) => r.url().endsWith('/submitted'), { timeout: 180_000 });
  await panel.getByRole('button', { name: 'Build and sign' }).click();
  const actionId = await opened;
  const txHash = (JSON.parse((await recorded).postData() ?? '{}') as { txHash: string }).txHash;
  console.log(`[e2e] ${label}: action ${actionId} submitted as ${txHash}`);
  await expect(page.getByText('Submitted. It shows as confirming until the chain confirms it.')).toBeVisible();
  return { actionId, txHash };
}

/** The signing page lists keys by their first 8 and last 6 characters. */
export const shortKey = (k: string) => `${k.slice(0, 8)}...${k.slice(-6)}`;

/** The group id the signing link of an action belongs to, for a founding the id it creates. */
export async function groupIdOfAction(page: Page, actionId: string): Promise<string> {
  const res = await page.request.get(`/api/groups/actions/${actionId}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { groupId: string }).groupId;
}

/** Whether this run resumes an earlier action, see resumeOr. */
export const RESUMED = Boolean(process.env.E2E_RESUME_ACTION);

/**
 * E2E_RESUME_ACTION names the action of an earlier run whose submit already went through, so a
 * rerun after a later failure waits for that action instead of spending on a second one.
 */
export async function resumeOr(open: () => Promise<string>): Promise<string> {
  const resumed = process.env.E2E_RESUME_ACTION;
  if (resumed) {
    console.log(`[e2e] resuming action ${resumed}`);
    return resumed;
  }
  return open();
}
