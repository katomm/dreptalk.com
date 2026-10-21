// Shared setup for the SubmitGovAction DOM tests, which are split across
// several files so vitest can run them in parallel. vi.mock has to stay in
// each test file, so every file mocks the same three modules through the
// factories exported here, and calls useSubmitGovActionHarness() inside its
// describe for the per-test reset.
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { govActionDraftKey } from '@/lib/governance/govActionDraft.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from '@/lib/governance/guardrailScript.js';
import poolEconomicsFixture from '@/lib/governance/__fixtures__/poolEconomics660.json';
import { encodeBech32 } from '@/lib/crypto/bech32.js';
import { hexToBytes } from '@/lib/crypto/hex.js';

// The submit path awaits several mocked round trips while the wallet hook
// keeps re-scanning on its own interval, so the default one second can be
// tight on a loaded machine. Generous, not slow: it resolves as soon as the
// condition holds.
export const SLOW = { timeout: 5000 };

export const submitGovActionMock = vi.fn();

// The success screen's three renderings are driven entirely by
// startStatusPolling's onUpdate callback (successPolling.ts has its own
// tests for the 30 s/10 minute schedule itself, with no React involved).
// Mocking the call here lets a test feed it whichever state it wants
// directly and assert the rendering, instead of needing real 30 s/10 minute
// waits or fake timers, which turned out to hang testing-library's own
// waitFor under happy-dom (its MutationObserver notifications depend on the
// very timers a full-fake-timers test replaces). The captured fetchStatus is
// still the island's real function, so a test can still call it once against
// the mocked fetch below to check the request it actually sends.
interface TestGovActionStatusResponse {
  synced: boolean;
  slug: string | null;
  draft: { slug: string; title: string } | null;
}
type TestSuccessPollState =
  | { kind: 'pending' }
  | { kind: 'synced'; slug: string | null; draft: { slug: string; title: string } | null }
  | { kind: 'timed-out' };
export interface CapturedStatusPoll {
  fetchStatus: () => Promise<TestGovActionStatusResponse | null>;
  onUpdate: (state: TestSuccessPollState) => void;
  /** The cancel function startStatusPolling returned for this call, so a test can assert cleanup. */
  cancel: ReturnType<typeof vi.fn>;
}
export const startStatusPollingMock = vi.fn((deps: { fetchStatus: CapturedStatusPoll['fetchStatus']; onUpdate: CapturedStatusPoll['onUpdate'] }) => {
  const cancel = vi.fn();
  mocks.capturedPolls.push({ ...deps, cancel });
  return cancel;
});

export type MockUtxos = { assets: { lovelace: bigint } }[];

/** A promise plus its resolver, for holding a mocked round trip open. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

export const DRAFT_KEY = govActionDraftKey('preprod');
// Passed to every render: "Sign as author" is on by default with this as the
// prefilled name, mirroring the signed-in display name new.astro resolves.
export const DISPLAY_NAME = 'Jane DRep';
export const MEMBER_A = 'a'.repeat(56);
export const NEW_MEMBER = 'b'.repeat(56);
export const SCRIPT_MEMBER = 'c'.repeat(56);
const OPEN_HASH = 'f'.repeat(64);
export const REWARD_ADDRESS = 'e0'.concat('c'.repeat(56));
/** REWARD_ADDRESS as the bech32 stake address a recipient row takes. */
export const REWARD_STAKE_ADDRESS = encodeBech32('stake_test', hexToBytes(REWARD_ADDRESS));

const EPOCH_PARAMS_ROW = {
  epoch_no: 500,
  gov_action_deposit: 100_000_000_000,
  gov_action_lifetime: 6,
  protocol_major: 10,
  protocol_minor: 0,
  committee_max_term_length: 100,
  dvt_motion_no_confidence: 0.67,
  dvt_committee_normal: 0.67,
  dvt_update_to_constitution: 0.75,
  dvt_hard_fork_initiation: 0.6,
  pvt_motion_no_confidence: 0.51,
  pvt_committee_normal: 0.51,
  pvt_hard_fork_initiation: 0.51,
  // The staking parameters in force, for the old values in the review of a parameter change.
  optimal_pool_count: 500,
  influence: 0.3,
};

export const COMMITTEE_CONTEXT = {
  epoch: 500,
  prev: {
    lastEnacted: {
      txHash: 'd'.repeat(64),
      index: 0,
      id: 'gov_action1root',
      type: 'NewCommittee',
      title: 'The sitting committee',
      proposedEpoch: 400,
    },
    open: [],
  },
  committee: {
    members: [{ coldHex: MEMBER_A, hasScript: false, expirationEpoch: 600 }],
    quorum: { numerator: 2, denominator: 3 },
    maxTermLength: 100,
  },
};

// The same chain, but the sitting member carries a display name with markup in
// it, for the preview card's escaping test. A committee name is stored by hand
// in ccMemberName, so it is exactly the kind of field that has to be a text
// node on every surface that shows it.
export const NAMED_COMMITTEE_CONTEXT = {
  ...COMMITTEE_CONTEXT,
  committee: {
    ...COMMITTEE_CONTEXT.committee,
    members: [
      { coldHex: MEMBER_A, hasScript: false, expirationEpoch: 600, name: '<img src=x onerror=alert(1)>' },
    ],
  },
};

// A chain with no committee on record: no members to tick and no quorum to
// fall back to, which is the one committee state whose payload carries nothing
// at all. The preview card has to stay away in that case, exactly as
// GaOnchainChanges.astro does.
export const EMPTY_COMMITTEE_CONTEXT = {
  ...COMMITTEE_CONTEXT,
  committee: { members: [], quorum: null, maxTermLength: null },
};

// Same chain, but with an open proposal to chain onto (so the committee panel
// can be switched into open mode) and a script member in the sitting
// committee, for the add-row suggestion test: the fix this covers is the
// datalist offering typed (bech32) credentials rather than bare hex, since a
// bare hex suggestion for a script member would silently add it as a key.
export const OPEN_COMMITTEE_CONTEXT = {
  ...COMMITTEE_CONTEXT,
  prev: {
    ...COMMITTEE_CONTEXT.prev,
    open: [
      {
        txHash: OPEN_HASH,
        index: 0,
        id: 'gov_action1open',
        type: 'UpdateCommittee',
        title: 'An open committee change',
        proposedEpoch: 480,
      },
    ],
  },
  committee: {
    members: [
      { coldHex: MEMBER_A, hasScript: false, expirationEpoch: 600 },
      { coldHex: SCRIPT_MEMBER, hasScript: true, expirationEpoch: 650 },
    ],
    quorum: { numerator: 2, denominator: 3 },
    maxTermLength: 100,
  },
};

// A sitting member whose cold hash is not 56 hex characters, which is what an
// upstream context row may carry. ccColdBech32 refuses it, and the panel has to
// show the hex rather than throw out of a render.
export const MALFORMED_MEMBER = 'a'.repeat(54);
export const MALFORMED_COMMITTEE_CONTEXT = {
  ...COMMITTEE_CONTEXT,
  committee: {
    ...COMMITTEE_CONTEXT.committee,
    members: [{ coldHex: MALFORMED_MEMBER, hasScript: false, expirationEpoch: 600 }],
  },
};

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

// The witness the mocked wallet hands back for a signed body hash, a fixed
// COSE_Sign1 signature/key pair the island passes straight through as
// author.keyHex / author.signatureHex.
export const WITNESS_SIGNATURE = 'a1'.repeat(32);
export const WITNESS_KEY = 'a4'.repeat(20);

export const RECIPIENT_HEX = `e0${'ab'.repeat(28)}`;
export const RECIPIENT = encodeBech32('stake_test', hexToBytes(RECIPIENT_HEX));
export const TREASURY_CONTEXT = { epoch: 500, guardrail: { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX } };

// A parameter change chain with no root yet, the guardrail in force and the
// staking parameters in force (k 500, a0 0.3, minPoolCost 170 ada, rho 0.3%,
// tau 20%).
export const PARAM_CONTEXT = {
  epoch: 660,
  prev: { lastEnacted: null, open: [] },
  guardrail: { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX },
  committee: { members: [], quorum: { numerator: 2, denominator: 3 }, maxTermLength: null },
  params: {
    k: { n: '500', d: '1' },
    a0: { n: '3', d: '10' },
    minPoolCost: { n: '170000000', d: '1' },
    rho: { n: '3', d: '1000' },
    tau: { n: '1', d: '5' },
  },
};

/** The same parameters on a chain whose root is the enacted change with the given tx hash. */
export function paramContextWithRoot(txHash: string) {
  return {
    ...PARAM_CONTEXT,
    prev: {
      lastEnacted: { txHash, index: 0, id: `gov_action1${txHash.slice(0, 8)}`, type: 'ParameterChange', title: 'An enacted change', proposedEpoch: 600 },
      open: [],
    },
  };
}

/**
 * Routes every request the island makes, so no test depends on a real network.
 * The init argument lets account_info answer per address and a test assert what a POST sent.
 */
export function installFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/preview')) {
      return mocks.previewImpl
        ? await mocks.previewImpl()
        : jsonResponse({
            html: {
              abstract: '<p>The rendered <strong>abstract</strong>.</p>',
              body: '<p>The rendered motivation.</p>\n<p>The rendered rationale.</p>',
            },
          });
    }
    if (url.includes('/api/koios/epoch_params')) return jsonResponse([EPOCH_PARAMS_ROW]);
    if (url.includes('/api/koios/account_info')) {
      if (mocks.accountInfoFails) return new Response('unavailable', { status: 503 });
      const body = JSON.parse(String(init?.body ?? '{}')) as { _stake_addresses?: string[] };
      return jsonResponse(
        (body._stake_addresses ?? []).map((address) => ({
          stake_address: address,
          status: mocks.recipientStatus.get(address) ?? mocks.stakeStatus,
        })),
      );
    }
    if (url.includes('/api/gov-action/context')) {
      if (mocks.contextError) {
        return new Response(JSON.stringify(mocks.contextError), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return mocks.contextHold ? await mocks.contextHold : jsonResponse(mocks.committeeContext);
    }
    if (url.includes('/api/gov-action/pool-economics')) {
      if (mocks.poolEconomicsFailures > 0) {
        mocks.poolEconomicsFailures -= 1;
        return new Response('unavailable', { status: 503 });
      }
      return jsonResponse(poolEconomicsFixture);
    }
    if (url.includes('/api/gov-action/status')) {
      return mocks.statusImpl ? await mocks.statusImpl() : jsonResponse({ synced: false, slug: null, draft: null });
    }
    // Checked before the bare /metadata branch below: prepare only returns
    // the body hash to sign, never the anchor the finalize call returns.
    if (url.includes('/api/gov-action/metadata/prepare')) {
      return jsonResponse({ bodyHash: 'b'.repeat(64) });
    }
    if (url.includes('/api/gov-action/metadata')) {
      if (mocks.metadataImpl) return mocks.metadataImpl();
      return jsonResponse({ anchorUrl: 'ipfs://meta', anchorHash: 'e'.repeat(64) });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The minimum CIP-30 surface the connect step and the submit path touch. */
export function installWalletMock() {
  const api = {
    getNetworkId: vi.fn(async () => 0),
    getRewardAddresses: vi.fn(async () => [REWARD_ADDRESS]),
    getUsedAddresses: vi.fn(async () => []),
    getUnusedAddresses: vi.fn(async () => []),
    getUtxos: vi.fn(async () => []),
    // Real CIP-30 shape: { signature, key }, the COSE_Sign1 signature plus
    // its COSE_Key, which is what the author witness reads.
    signData: vi.fn(async () => ({ signature: WITNESS_SIGNATURE, key: WITNESS_KEY })),
    signTx: vi.fn(),
    submitTx: vi.fn(),
  };
  (window as unknown as { cardano: unknown }).cardano = {
    testwallet: { name: 'Test Wallet', icon: '', enable: vi.fn(async () => api) },
  };
  return api;
}

/** The injected extension entry, for tests that control enable() themselves. */
export function walletEntry(): { enable: ReturnType<typeof vi.fn> } {
  return (window as unknown as { cardano: Record<string, { enable: ReturnType<typeof vi.fn> }> }).cardano.testwallet;
}

/**
 * Connects the wallet and waits for the balance read to come back. Matches on
 * "wallet" too because the type cards now carry their own "Deposit ..." line
 * regardless of wallet state, so a bare /^Deposit / would find more than one.
 */
export async function connect() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));
  await screen.findByText(/^Deposit .*wallet/, {}, SLOW);
}

/**
 * The Sign and submit button, which lives in the Review dialog. Opens the
 * dialog first when it is not open yet, the way a user has to.
 */
export function signButton(): HTMLButtonElement {
  const open = screen.queryByRole('button', { name: 'Sign and submit' });
  if (open) return open as HTMLButtonElement;
  fireEvent.click(screen.getByRole('button', { name: 'Review and submit' }));
  return screen.getByRole('button', { name: 'Sign and submit' }) as HTMLButtonElement;
}

export function fillMetadata() {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A committee change' } });
  fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: 'The abstract' } });
  fireEvent.change(screen.getByLabelText('Motivation'), { target: { value: 'The motivation' } });
  fireEvent.change(screen.getByLabelText('Rationale'), { target: { value: 'The rationale' } });
}

/** Switches to UpdateCommittee, ticks the sitting member and adds one. */
export async function fillCommitteePanel() {
  fireEvent.click(screen.getByRole('radio', { name: /Update committee/ }));
  await screen.findByText('Members to remove');
  fireEvent.click(screen.getByDisplayValue(MEMBER_A));
  fireEvent.click(screen.getByRole('button', { name: 'Add a member' }));
  fireEvent.change(screen.getByLabelText('Credential to add 1'), { target: { value: NEW_MEMBER } });
  fireEvent.change(screen.getByLabelText('Expiry epoch for addition 1'), { target: { value: '560' } });
}

/** Switches to TreasuryWithdrawals and fills the first recipient row. */
export async function fillTreasuryPanel(address = RECIPIENT, amount = '1') {
  fireEvent.click(screen.getByRole('radio', { name: /Treasury withdrawal/ }));
  await screen.findByLabelText('Recipient 1 stake address', {}, SLOW);
  fireEvent.change(screen.getByLabelText('Recipient 1 stake address'), { target: { value: address } });
  fireEvent.change(screen.getByLabelText('Recipient 1 amount in tADA'), { target: { value: amount } });
}

/** Switches to ParameterChange and types the given values into their cards, picking each by its chip. */
export async function fillParamPanel(inputs: { k?: string; a0?: string }) {
  fireEvent.click(await screen.findByRole('radio', { name: /Protocol parameter change/ }, SLOW));
  await screen.findByRole('button', { name: 'k' }, SLOW);
  if (inputs.k !== undefined) {
    fireEvent.click(screen.getByRole('button', { name: 'k' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New Target number of pools' }), { target: { value: inputs.k } });
  }
  if (inputs.a0 !== undefined) {
    fireEvent.click(screen.getByRole('button', { name: 'a0' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New Pledge influence' }), { target: { value: inputs.a0 } });
  }
}

/** The requests the island sent whose URL contains the fragment. */
export function requestsTo(fetchMock: ReturnType<typeof installFetchMock>, fragment: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(fragment)).length;
}

/**
 * What the mocked modules and routes answer with. Tests override a field for
 * the case they cover, useSubmitGovActionHarness resets all of them before
 * every test.
 */
interface HarnessMocks {
  /** The balance the mocked UTxO collector reports. */
  walletLovelace: bigint;
  /**
   * Set by the tests that need a balance read to stay open while something
   * else happens, null for the ordinary "answers immediately" case.
   */
  collectWalletUtxosImpl: (() => Promise<MockUtxos>) | null;
  /** The /api/gov-action/context answer, the plain enacted-mode fixture by default. */
  committeeContext: unknown;
  /** The /api/preview answer, for the tests that need a failure or a specific body. */
  previewImpl: (() => Promise<Response>) | null;
  /**
   * The /api/gov-action/status answer for the success screen's sync poll.
   * Defaults to "not synced yet", the common case for every test that only
   * cares about reaching the success screen at all.
   */
  statusImpl: (() => Promise<Response>) | null;
  /** What Koios account_info reports for the wallet's reward address. */
  stakeStatus: string;
  /** Per-address account_info status for treasury recipients, every other address answers stakeStatus. */
  recipientStatus: Map<string, string>;
  /** When set, every /api/gov-action/context request answers 503 with this body. */
  contextError: { error: string } | null;
  /** When true, every /api/koios/account_info request answers 503. */
  accountInfoFails: boolean;
  /** Overrides the bare /api/gov-action/metadata answer when set. */
  metadataImpl: (() => Response) | null;
  /** How many of the next /api/gov-action/pool-economics requests answer 503. */
  poolEconomicsFailures: number;
  /**
   * Holds every /api/gov-action/context response open on this promise instead
   * of answering at once, for the test that has to catch a second request
   * starting while the first (the submit's own freshness refetch) is still in
   * flight.
   */
  contextHold: Promise<Response> | null;
  /** Every startStatusPolling call the island made, in order. */
  capturedPolls: CapturedStatusPoll[];
}
export const mocks = {} as HarnessMocks;

/** Factory for vi.mock('@/lib/governance/govActionTx.js'). */
export function govActionTxMock() {
  return { submitGovAction: (...args: unknown[]) => submitGovActionMock(...args) };
}

/** Factory for vi.mock('@/lib/governance/successPolling.js'), given the real module. */
export function successPollingMock(actual: typeof import('@/lib/governance/successPolling.js')) {
  return {
    ...actual,
    startStatusPolling: (deps: unknown) =>
      startStatusPollingMock(deps as { fetchStatus: CapturedStatusPoll['fetchStatus']; onUpdate: CapturedStatusPoll['onUpdate'] }),
  };
}

// The balance read goes through the collector, not through getUtxos: it reads
// Koios by the wallet's addresses, so the wallet mock cannot control it. Only
// the collector is replaced, so totalLovelace and the funding headroom stay
// the real ones the transaction builder uses.
// Factory for vi.mock('@/lib/governance/walletUtxos.js'), given the real module.
export function walletUtxosMock(actual: typeof import('@/lib/governance/walletUtxos.js')) {
  return {
    ...actual,
    collectWalletUtxos: async () =>
      mocks.collectWalletUtxosImpl ? await mocks.collectWalletUtxosImpl() : [{ assets: { lovelace: mocks.walletLovelace } }],
  };
}

/** Registers the per-test reset and teardown. Call it inside the file's describe. */
export function useSubmitGovActionHarness() {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.capturedPolls = [];
    submitGovActionMock.mockReset();
    mocks.walletLovelace = 200_000_000_000n;
    mocks.collectWalletUtxosImpl = null;
    mocks.committeeContext = COMMITTEE_CONTEXT;
    mocks.previewImpl = null;
    mocks.statusImpl = null;
    mocks.stakeStatus = 'registered';
    mocks.contextHold = null;
    mocks.recipientStatus = new Map();
    mocks.contextError = null;
    mocks.accountInfoFails = false;
    mocks.poolEconomicsFailures = 0;
    mocks.metadataImpl = null;
    installFetchMock();
    installWalletMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // A no-op when a test never switched to fake timers, and a safety net for
    // the poll-schedule tests in SubmitGovAction.submit.dom.test.tsx, so a
    // failure mid-test cannot leak fake timers into the next one.
    vi.useRealTimers();
  });
}
