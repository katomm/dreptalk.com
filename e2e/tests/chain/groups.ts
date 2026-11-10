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
// The founding specs give their group a name unique to the run and keep its id in
// e2e/.chain-state.json (gitignored), where the later specs read it. E2E_SOLO_GROUP_ID and
// E2E_JOINT_GROUP_ID override the file, for example to point the later specs at an older group.
// The founders of a new group are mostly members of older groups already, and the group list counts
// a DRep only toward its oldest group, so a group of a rerun is on its group page but not listed.
import fs from 'node:fs';
import type { Browser, Page, TestInfo } from '@playwright/test';
import { attachWallet, expect, type WalletHandle } from 'cip30-test-wallet/playwright';
import { koiosToken } from '../../dev-vars.js';
import { signIn, waitForHydration } from '../helpers.js';

const MNEMONIC = process.env.PREPROD_TEST_WALLET_MNEMONIC;

/** Wallet options of an account of the test seed, reading and submitting on preprod. */
export const chainWallet = (accountIndex: number) => ({
  mnemonic: MNEMONIC,
  accountIndex,
  ledger: { chain: { provider: 'koios' as const, network: 'preprod' as const, token: koiosToken() } },
});

const SYNC_URL = process.env.E2E_SYNC_URL ?? 'http://127.0.0.1:8789';
/** The governance cron, which runs the drep-groups phase last. */
const GOVERNANCE_CRON = '*/5 * * * *';

/** A whole run waits for a submit, ten blocks of depth and the ticks that judge it. */
export const CHAIN_TIMEOUT = 30 * 60_000;

/** The signing page's line once the engine judged the transaction as applied. */
export const APPLIED = 'The transaction is confirmed and the group change is in effect.';
export const CONFIRMING = 'The transaction is submitted and waiting for the chain to confirm it.';

/**
 * The groups of a run: `solo` is the throwaway group the solo founding creates and the dissolve
 * ends, `joint` the 2 of 3 group of accounts 0, 1 and 2 for the join request, admission and leave.
 */
export type ChainGroupKind = 'solo' | 'joint';
const GROUP_NAMES: Record<ChainGroupKind, string> = { solo: 'E2E test throwaway group (solo)', joint: 'E2E test joint group (2 of 3)' };
const GROUP_ID_ENV: Record<ChainGroupKind, string> = { solo: 'E2E_SOLO_GROUP_ID', joint: 'E2E_JOINT_GROUP_ID' };

/** The state the founding specs hand to the later ones, a file because each spec is its own run. */
const STATE_FILE = new URL('../../.chain-state.json', import.meta.url);
type ChainGroup = { name: string; actionId?: string; id?: string };
type ChainState = Partial<Record<ChainGroupKind, ChainGroup>>;

const readState = (): ChainState => (fs.existsSync(STATE_FILE) ? (JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as ChainState) : {});

/** Merges `group` into the stored group of `kind`. */
export function saveGroup(kind: ChainGroupKind, group: Partial<ChainGroup>): void {
  const state = readState();
  state[kind] = { ...state[kind], ...group } as ChainGroup;
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The name a founding spec gives its group: the base name plus the time of the run, so a rerun
 * never meets a group of the same name. A resumed founding keeps the name stored by its first run.
 */
export function foundingName(kind: ChainGroupKind): string {
  const stored = readState()[kind];
  if (RESUMED) {
    if (!stored?.name) throw new Error(`E2E_RESUME_ACTION is set but ${STATE_FILE.pathname} has no ${kind} group name`);
    return stored.name;
  }
  const tag = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const name = `${GROUP_NAMES[kind]} ${tag}`;
  // Stored before the submit, so a resumed run finds the name again. The id follows once applied.
  fs.writeFileSync(STATE_FILE, `${JSON.stringify({ ...readState(), [kind]: { name } }, null, 2)}\n`);
  return name;
}

/** The group of `kind` the founding spec of this run created, from the env override or the state file. */
export function chainGroup(kind: ChainGroupKind): { id: string; name?: string } {
  const override = process.env[GROUP_ID_ENV[kind]];
  if (override) return { id: override };
  const stored = readState()[kind];
  if (!stored?.id) {
    throw new Error(`no ${kind} group id: run the found-${kind} spec first (it writes ${STATE_FILE.pathname}) or set ${GROUP_ID_ENV[kind]}`);
  }
  return { id: stored.id, name: stored.name };
}

/**
 * Checks the listing rule for a group of a rerun: the group list renders groups but not this one,
 * whose founders count toward their older group, and the founder's DRep page links it.
 */
export async function expectUnlistedButLinked(page: Page, groupId: string, founderDrepId: string): Promise<void> {
  await page.goto('/groups/');
  await expect(page.locator('a[href^="/groups/drep_group1"]').first()).toBeVisible();
  await expect(page.locator(`a[href="/groups/${groupId}/"]`)).toHaveCount(0);
  await page.goto(`/dreps/${founderDrepId}/`);
  await expect(page.locator(`a.drep-hd__group[href="/groups/${groupId}/"]`)).toBeVisible();
}

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

/**
 * On a resumed run, submits the action when every signature is collected but the submit never
 * went through, for a run that failed between the last signature and the submit.
 */
export async function submitIfCollected(page: Page, actionId: string): Promise<void> {
  if (!RESUMED) return;
  await page.goto(`/groups/sign/${actionId}/`);
  await waitForHydration(page);
  // The panel loads the action after hydration, so give it time before deciding.
  const submit = page.getByRole('region', { name: 'Submit' }).getByRole('button', { name: 'Submit transaction' });
  const ready = await submit.waitFor({ timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  if (ready) await submitOnSigningPage(page, actionId);
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
 * rerun after a later failure waits for that action instead of spending on a second one. A
 * multi-signer spec also submits a resumed action that has all its signatures, see submitIfCollected.
 */
export async function resumeOr(open: () => Promise<string>): Promise<string> {
  const resumed = process.env.E2E_RESUME_ACTION;
  if (resumed) {
    console.log(`[e2e] resuming action ${resumed}`);
    return resumed;
  }
  return open();
}
