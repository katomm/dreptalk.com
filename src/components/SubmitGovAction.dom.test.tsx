// @vitest-environment happy-dom
// The DOM tests for the submit island. Everything decidable without React is
// covered by the reducer, readiness.ts and the leaf validators, so these tests
// exist for exactly what those cannot reach: the effects and their dependency
// lists, and the wiring between the form, the wallet step and the readiness
// list. Three things break silently if a dependency list is wrong, and all
// three are asserted here: a type switch must not touch the metadata or lose a
// panel, a remount must restore the whole form from storage (which means the
// save effect has to have written the panels and the type, not just the text),
// and a rejected submit must leave both the form and the stored draft alone.
// The wallet-last scenarios are the other half: the form has to be usable with
// no wallet and no extension at all.
//
// The environment is file-scoped on purpose: the node and workers test
// projects keep their own environments.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

// The submit path awaits several mocked round trips while the wallet hook
// keeps re-scanning on its own interval, so the default one second can be
// tight on a loaded machine. Generous, not slow: it resolves as soon as the
// condition holds.
const SLOW = { timeout: 5000 };
import SubmitGovAction from './SubmitGovAction.js';
import { loadGovActionDraft, govActionDraftKey } from '@/lib/governance/govActionDraft.js';
import { ccColdBech32 } from '@/lib/governance/committeeUpdate.js';

const submitGovActionMock = vi.fn();
vi.mock('@/lib/governance/govActionTx.js', () => ({
  submitGovAction: (...args: unknown[]) => submitGovActionMock(...args),
}));

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
interface CapturedStatusPoll {
  fetchStatus: () => Promise<TestGovActionStatusResponse | null>;
  onUpdate: (state: TestSuccessPollState) => void;
  /** The cancel function startStatusPolling returned for this call, so a test can assert cleanup. */
  cancel: ReturnType<typeof vi.fn>;
}
let capturedPolls: CapturedStatusPoll[] = [];
const startStatusPollingMock = vi.fn((deps: { fetchStatus: CapturedStatusPoll['fetchStatus']; onUpdate: CapturedStatusPoll['onUpdate'] }) => {
  const cancel = vi.fn();
  capturedPolls.push({ ...deps, cancel });
  return cancel;
});
vi.mock('@/lib/governance/successPolling.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/governance/successPolling.js')>();
  return {
    ...actual,
    startStatusPolling: (deps: unknown) =>
      startStatusPollingMock(deps as { fetchStatus: CapturedStatusPoll['fetchStatus']; onUpdate: CapturedStatusPoll['onUpdate'] }),
  };
});

// The balance read goes through the collector, not through getUtxos: it reads
// Koios by the wallet's addresses, so the wallet mock cannot control it. Only
// the collector is replaced, so totalLovelace and the funding headroom stay
// the real ones the transaction builder uses.
let walletLovelace = 200_000_000_000n;
type MockUtxos = { assets: { lovelace: bigint } }[];
// Set by the tests that need a read to stay open while something else
// happens, null for the ordinary "answers immediately" case.
let collectWalletUtxosImpl: (() => Promise<MockUtxos>) | null = null;
vi.mock('@/lib/governance/walletUtxos.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/governance/walletUtxos.js')>();
  return {
    ...actual,
    collectWalletUtxos: async () =>
      collectWalletUtxosImpl ? await collectWalletUtxosImpl() : [{ assets: { lovelace: walletLovelace } }],
  };
});

/** A promise plus its resolver, for holding a mocked round trip open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const DRAFT_KEY = govActionDraftKey('preprod');
// Passed to every render: "Sign as author" is on by default with this as the
// prefilled name, mirroring the signed-in display name new.astro resolves.
const DISPLAY_NAME = 'Jane DRep';
const MEMBER_A = 'a'.repeat(56);
const NEW_MEMBER = 'b'.repeat(56);
const SCRIPT_MEMBER = 'c'.repeat(56);
const OPEN_HASH = 'f'.repeat(64);
const REWARD_ADDRESS = 'e0'.concat('c'.repeat(56));

const EPOCH_PARAMS_ROW = {
  epoch_no: 500,
  gov_action_deposit: 100_000_000_000,
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
};

const COMMITTEE_CONTEXT = {
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
const NAMED_COMMITTEE_CONTEXT = {
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
const EMPTY_COMMITTEE_CONTEXT = {
  ...COMMITTEE_CONTEXT,
  committee: { members: [], quorum: null, maxTermLength: null },
};

// Same chain, but with an open proposal to chain onto (so the committee panel
// can be switched into open mode) and a script member in the sitting
// committee, for the add-row suggestion test: the fix this covers is the
// datalist offering typed (bech32) credentials rather than bare hex, since a
// bare hex suggestion for a script member would silently add it as a key.
const OPEN_COMMITTEE_CONTEXT = {
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

// Overridden per test that needs a different chain context; reset to the
// plain enacted-mode fixture in beforeEach.
let committeeContext: unknown = COMMITTEE_CONTEXT;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

// The witness the mocked wallet hands back for a signed body hash, a fixed
// COSE_Sign1 signature/key pair the island passes straight through as
// author.keyHex / author.signatureHex.
const WITNESS_SIGNATURE = 'a1'.repeat(32);
const WITNESS_KEY = 'a4'.repeat(20);

// What the mocked /api/preview answers with. Replaced by the tests that need a
// failure or a specific body. Reset in beforeEach.
let previewImpl: (() => Promise<Response>) | null = null;

// What the mocked /api/gov-action/status answers with, for the success
// screen's sync poll. Replaced by the tests that drive it through several
// answers. Reset in beforeEach. Defaults to "not synced yet", the common case
// for every test that only cares about reaching the success screen at all.
let statusImpl: (() => Promise<Response>) | null = null;

// Holds every /api/gov-action/context response open on the given promise
// instead of answering at once, for the test that has to catch a second
// request starting while the first (the submit's own freshness refetch) is
// still in flight. Reset in beforeEach.
let contextHold: Promise<Response> | null = null;

/** Routes every request the island makes, so no test depends on a real network. */
function installFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/preview')) {
      return previewImpl
        ? await previewImpl()
        : jsonResponse({
            html: {
              abstract: '<p>The rendered <strong>abstract</strong>.</p>',
              motivation: '<p>The rendered motivation.</p>',
              rationale: '<p>The rendered rationale.</p>',
            },
          });
    }
    if (url.includes('/api/koios/epoch_params')) return jsonResponse([EPOCH_PARAMS_ROW]);
    if (url.includes('/api/gov-action/context')) return contextHold ? await contextHold : jsonResponse(committeeContext);
    if (url.includes('/api/gov-action/status')) {
      return statusImpl ? await statusImpl() : jsonResponse({ synced: false, slug: null, draft: null });
    }
    // Checked before the bare /metadata branch below: prepare only returns
    // the body hash to sign, never the anchor the finalize call returns.
    if (url.includes('/api/gov-action/metadata/prepare')) {
      return jsonResponse({ bodyHash: 'b'.repeat(64) });
    }
    if (url.includes('/api/gov-action/metadata')) {
      return jsonResponse({ anchorUrl: 'ipfs://meta', anchorHash: 'e'.repeat(64) });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The minimum CIP-30 surface the connect step and the submit path touch. */
function installWalletMock() {
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
function walletEntry(): { enable: ReturnType<typeof vi.fn> } {
  return (window as unknown as { cardano: Record<string, { enable: ReturnType<typeof vi.fn> }> }).cardano.testwallet;
}

/**
 * Connects the wallet and waits for the balance read to come back. Matches on
 * "wallet" too because the type cards now carry their own "Deposit ..." line
 * regardless of wallet state, so a bare /^Deposit / would find more than one.
 */
async function connect() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));
  await screen.findByText(/^Deposit .*wallet/, {}, SLOW);
}

function fillMetadata() {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A committee change' } });
  fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: 'The abstract' } });
  fireEvent.change(screen.getByLabelText('Motivation'), { target: { value: 'The motivation' } });
  fireEvent.change(screen.getByLabelText('Rationale'), { target: { value: 'The rationale' } });
}

/** Switches to UpdateCommittee, ticks the sitting member and adds one. */
async function fillCommitteePanel() {
  fireEvent.click(screen.getByRole('radio', { name: /Update committee/ }));
  await screen.findByText('Members to remove');
  fireEvent.click(screen.getByDisplayValue(MEMBER_A));
  fireEvent.click(screen.getByRole('button', { name: 'Add a member' }));
  fireEvent.change(screen.getByLabelText('Credential to add 1'), { target: { value: NEW_MEMBER } });
  fireEvent.change(screen.getByLabelText('Expiry epoch for addition 1'), { target: { value: '560' } });
}

describe('SubmitGovAction', () => {
  beforeEach(() => {
    window.localStorage.clear();
    submitGovActionMock.mockReset();
    walletLovelace = 200_000_000_000n;
    collectWalletUtxosImpl = null;
    committeeContext = COMMITTEE_CONTEXT;
    previewImpl = null;
    statusImpl = null;
    contextHold = null;
    installFetchMock();
    installWalletMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // A no-op when a test never switched to fake timers, and a safety net for
    // the poll-schedule tests below so a failure mid-test cannot leak fake
    // timers into the next one.
    vi.useRealTimers();
  });

  it('keeps the metadata across a type switch and restores the panel on the way back', async () => {
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    await connect();
    fillMetadata();
    await fillCommitteePanel();

    fireEvent.click(screen.getByRole('radio', { name: /Info action/ }));
    await waitFor(() => expect(screen.queryByText('Members to remove')).toBeNull());
    // The metadata belongs to every type, so a switch must not clear it.
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    expect((screen.getByLabelText('Rationale') as HTMLTextAreaElement).value).toBe('The rationale');

    fireEvent.click(screen.getByRole('radio', { name: /Update committee/ }));
    await screen.findByLabelText('Credential to add 1');
    expect((screen.getByLabelText('Credential to add 1') as HTMLInputElement).value).toBe(NEW_MEMBER);
    expect((screen.getByLabelText('Expiry epoch for addition 1') as HTMLInputElement).value).toBe('560');
    expect((screen.getByDisplayValue(MEMBER_A) as HTMLInputElement).checked).toBe(true);
  });

  it('restores the type, the metadata and the panel from storage after a remount', async () => {
    const first = render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    await connect();
    fillMetadata();
    await fillCommitteePanel();
    await waitFor(() => expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)?.type).toBe('UpdateCommittee'), SLOW);
    first.unmount();

    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    await connect();
    expect((screen.getByRole('radio', { name: /Update committee/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    await screen.findByLabelText('Credential to add 1');
    expect((screen.getByLabelText('Credential to add 1') as HTMLInputElement).value).toBe(NEW_MEMBER);
    expect((screen.getByLabelText('Quorum numerator') as HTMLInputElement).value).toBe('2');
  });

  it('leaves the form and the draft intact when the transaction is rejected', async () => {
    submitGovActionMock.mockRejectedValue(new Error('user declined the transaction'));
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    await connect();
    fillMetadata();
    await fillCommitteePanel();

    // The button stays disabled until the quorum prefill effect has run and
    // the panel validates, so waiting on it is what makes the click land.
    const submit = screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
    fireEvent.click(submit);

    await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
    const opts = submitGovActionMock.mock.calls[0][0] as { action: unknown; rewardAddressHex: string };
    expect(opts.rewardAddressHex).toBe(REWARD_ADDRESS);
    expect(opts.action).toEqual({
      type: 'UpdateCommittee',
      prev: { txHashHex: 'd'.repeat(64), index: 0 },
      remove: [{ hashHex: MEMBER_A, isScript: false }],
      add: [{ credential: { hashHex: NEW_MEMBER, isScript: false }, expiryEpoch: 560 }],
      quorum: { numerator: 2, denominator: 3 },
    });

    await screen.findByText(/declined/i);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    expect((screen.getByLabelText('Credential to add 1') as HTMLInputElement).value).toBe(NEW_MEMBER);
    const draft = loadGovActionDraft(window.localStorage, DRAFT_KEY);
    expect(draft?.type).toBe('UpdateCommittee');
    expect(draft?.title).toBe('A committee change');
  });

  it('suggests a script member as a typed bech32 credential in open mode, so picking it adds a script credential', async () => {
    committeeContext = OPEN_COMMITTEE_CONTEXT;
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    await connect();
    fillMetadata();

    fireEvent.click(screen.getByRole('radio', { name: /Update committee/ }));
    await screen.findByText('Members to remove');

    fireEvent.click(screen.getByText('Advanced: chain onto an open proposal'));
    fireEvent.click(await screen.findByRole('radio', { name: /An open committee change/ }));
    await screen.findByText(/Chained onto a proposal that is still open/);

    // The suggestion itself has to carry the kind: a bare hex value here
    // would add the script member as a key credential unless the user also
    // flips the toggle by hand.
    const scriptBech32 = ccColdBech32(SCRIPT_MEMBER, true);
    expect(document.querySelector(`#ga-committee-members option[value="${scriptBech32}"]`)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add a member' }));
    fireEvent.change(screen.getByLabelText('Credential to add 1'), { target: { value: scriptBech32 } });
    fireEvent.change(screen.getByLabelText('Expiry epoch for addition 1'), { target: { value: '560' } });

    const submit = screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
    fireEvent.click(submit);

    await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
    const opts = submitGovActionMock.mock.calls[0][0] as { action: { add: { credential: { hashHex: string; isScript: boolean } }[] } };
    expect(opts.action.add).toEqual([{ credential: { hashHex: SCRIPT_MEMBER, isScript: true }, expiryEpoch: 560 }]);
  });

  it('shows the whole form with no wallet extension at all, and says so in the sign section', async () => {
    (window as unknown as { cardano: unknown }).cardano = {};
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);

    // The form is the page, not something behind a wallet gate.
    fillMetadata();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    expect(screen.getByRole('radio', { name: /Update committee/ })).toBeTruthy();

    await screen.findByText('Connect a wallet');
    await screen.findByText(/No Cardano wallet extension detected/);
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks only for a wallet once the form itself is complete', async () => {
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await fillCommitteePanel();

    // Scoped to the readiness list itself, so the deposit callout's own bullet
    // list cannot stand in for a reason.
    await waitFor(() => {
      const list = screen.getByText('Before you can submit').parentElement as HTMLElement;
      const items = [...list.querySelectorAll('li')].map(li => li.textContent);
      expect(items).toEqual(['Connect a wallet']);
    }, SLOW);
  });

  it('keeps the filled form when the connect attempt fails', async () => {
    const cardano = (window as unknown as { cardano: Record<string, { enable: () => Promise<unknown> }> }).cardano;
    cardano.testwallet.enable = vi.fn(async () => {
      throw new Error('user rejected the connection');
    });
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    await screen.findByText(/rejected/i, {}, SLOW);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    // Back to no wallet, so the list asks for one again and the button offers a retry.
    await screen.findByText('Connect a wallet');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('names both figures on a short wallet and clears them after a top-up', async () => {
    // Deposit 100,000 tADA plus the 5 tADA reserve, against a 900 tADA wallet.
    walletLovelace = 900_000_000n;
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await fillCommitteePanel();
    await connect();

    await screen.findByText(
      'The wallet holds 900 tADA, the deposit plus a 5 tADA fee reserve needs 100,005',
      {},
      SLOW,
    );
    const submit = screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    walletLovelace = 200_000_000_000n;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText(/The wallet holds/)).toBeNull(), SLOW);
    await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
  });

  it('files a slow balance read against the wallet it was started for, not the next one', async () => {
    const slow = deferred<MockUtxos>();
    collectWalletUtxosImpl = () => slow.promise;
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    await screen.findByText('Reading the wallet balance...', {}, SLOW);

    // The user gives up on that wallet and connects another one, which answers
    // at once.
    fireEvent.click(screen.getByRole('button', { name: 'Use a different wallet' }));
    collectWalletUtxosImpl = null;
    walletLovelace = 200_000_000_000n;
    await connect();

    // The first wallet's read comes back last, and with a balance that would
    // block the submit if it were filed against the wallet now connected.
    slow.resolve([{ assets: { lovelace: 900_000_000n } }]);
    await waitFor(() => expect(submitGovActionMock).not.toHaveBeenCalled());
    expect(screen.getByText('Deposit 100,000 tADA, wallet 200,000 tADA')).toBeTruthy();
    expect(screen.queryByText(/The wallet holds/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says the balance read failed instead of claiming to still be reading', async () => {
    collectWalletUtxosImpl = async () => {
      throw new Error('Koios is down');
    };
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    await screen.findByText('Could not read the wallet balance, check again', {}, SLOW);
    expect(screen.queryByText('Reading the wallet balance...')).toBeNull();
    expect(screen.getByText(/Koios is down/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets the browser reject an invalid reference URL before anything is published', async () => {
    const fetchMock = installFetchMock();
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await connect();

    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    fireEvent.change(screen.getByLabelText('Reference 1 label'), { target: { value: 'The discussion' } });
    fireEvent.change(screen.getByLabelText('Reference 1 URL'), { target: { value: 'not a url' } });

    const submit = screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement;
    // Readiness has nothing against it: the URL rule is the browser's.
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(submitGovActionMock).not.toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gov-action/metadata'))).toBe(false);

    // The same click goes through once the URL is one.
    fireEvent.change(screen.getByLabelText('Reference 1 URL'), { target: { value: 'https://example.org/thread' } });
    fireEvent.click(submit);
    await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
  });

  it('rejects a wallet with no reward address and stays disconnected', async () => {
    const api = installWalletMock();
    api.getRewardAddresses = vi.fn(async () => []);
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    await screen.findByText(/exposes no reward address/, {}, SLOW);
    await screen.findByText('Connect a wallet');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(/^Deposit .*wallet/)).toBeNull();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
  });

  it('drops the balance and the address again on "Use a different wallet"', async () => {
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await connect();

    fireEvent.click(screen.getByRole('button', { name: 'Use a different wallet' }));

    await screen.findByText('Connect a wallet');
    expect(screen.queryByText(/^Deposit .*wallet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement).disabled).toBe(true);
    // The form is untouched by any of it.
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
  });

  it('enables the wallet once even when Connect is clicked twice', async () => {
    const api = installWalletMock();
    const slowEnable = deferred<unknown>();
    const entry = walletEntry();
    entry.enable = vi.fn(() => slowEnable.promise);
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);

    const connectButton = await screen.findByRole('button', { name: 'Connect wallet' });
    fireEvent.click(connectButton);
    await screen.findByRole('button', { name: 'Connecting...' });
    fireEvent.click(screen.getByRole('button', { name: 'Connecting...' }));

    slowEnable.resolve(api);
    await screen.findByText(/^Deposit .*wallet/, {}, SLOW);
    expect(entry.enable).toHaveBeenCalledTimes(1);
  });

  describe('sign as author, on by default', () => {
    /** Finds the fetch call to the bare finalize route, never the /prepare one. */
    function metadataCallBody(fetchMock: ReturnType<typeof installFetchMock>): Record<string, unknown> {
      const call = fetchMock.mock.calls.find(([url]) => {
        const s = String(url);
        return s.includes('/api/gov-action/metadata') && !s.includes('/prepare');
      }) as unknown[] | undefined;
      const init = call?.[1] as RequestInit | undefined;
      return JSON.parse(init?.body as string);
    }

    it('reaches submitGovAction with the prefilled name and a wallet witness', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'a'.repeat(64) });
      const fetchMock = installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await connect();

      const submit = screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement;
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gov-action/metadata/prepare')),
      ).toBe(true);
      expect(metadataCallBody(fetchMock).author).toEqual({
        name: DISPLAY_NAME,
        keyHex: WITNESS_KEY,
        signatureHex: WITNESS_SIGNATURE,
      });
    });

    it('reaches submitGovAction with no author once signing is turned off', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'b'.repeat(64) });
      const fetchMock = installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('checkbox', { name: /Sign as author/ }));
      await connect();

      const submit = screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement;
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gov-action/metadata/prepare')),
      ).toBe(false);
      expect('author' in metadataCallBody(fetchMock)).toBe(false);
    });
  });

  describe('Link a Proposal Draft', () => {
    const OPEN_DRAFTS = [
      { slug: 'fund-tooling-a1b2', title: 'Fund tooling', authorId: 'author-1', createdAt: 1, own: true },
      { slug: 'other-draft-c3d4', title: 'Someone else draft', authorId: 'author-2', createdAt: 1, own: false },
    ];
    const SITE_ORIGIN = 'https://preprod.dreptalk.com';

    it('picking a draft adds it as a reference in the shape the sync matcher recognizes', () => {
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: 'fund-tooling-a1b2' } });

      expect((screen.getByLabelText('Reference 1 label') as HTMLInputElement).value).toBe('Fund tooling');
      expect((screen.getByLabelText('Reference 1 URL') as HTMLInputElement).value).toBe(
        `${SITE_ORIGIN}/t/fund-tooling-a1b2/`,
      );
    });

    it('unlinking removes the reference it added', () => {
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: 'fund-tooling-a1b2' } });
      expect(screen.getByLabelText('Reference 1 label')).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: '' } });

      expect(screen.queryByLabelText('Reference 1 label')).toBeNull();
    });

    it('follows a hand-edited reference URI to a different open draft', () => {
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: 'fund-tooling-a1b2' } });
      expect((screen.getByLabelText('Link a Proposal Draft') as HTMLInputElement).value).toBe('fund-tooling-a1b2');

      // The same row's URL field, edited by hand to a different open draft's
      // thread, exactly as typing over it would.
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), {
        target: { value: `${SITE_ORIGIN}/t/other-draft-c3d4/` },
      });

      expect((screen.getByLabelText('Link a Proposal Draft') as HTMLInputElement).value).toBe('other-draft-c3d4');
    });
  });

  describe('draft restore banner', () => {
    function storedDraft(overrides: Partial<Record<string, unknown>> = {}): string {
      return JSON.stringify({
        v: 2,
        type: 'InfoAction',
        title: 'Old title',
        abstract: 'Old abstract',
        motivation: 'Old motivation',
        rationale: 'Old rationale',
        signAsAuthor: true,
        authorName: 'Someone else',
        references: [],
        surveyRef: '',
        panels: {},
        ...overrides,
      });
    }

    it('shows the relative time when the stored draft carries a savedAt', async () => {
      window.localStorage.setItem(DRAFT_KEY, storedDraft({ savedAt: Date.now() - 5 * 60 * 1000 }));
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/^Restored your draft from \d+m ago$/);
    });

    it('shows the plain fallback when the stored draft has no savedAt', async () => {
      window.localStorage.setItem(DRAFT_KEY, storedDraft());
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText('Restored your saved draft');
    });

    it('discard empties the form and storage, and a remount shows no banner', async () => {
      window.localStorage.setItem(DRAFT_KEY, storedDraft({ savedAt: Date.now() }));
      const first = render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/^Restored your draft from/);
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Old title');

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

      expect(screen.queryByText(/^Restored your/)).toBeNull();
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('Author name') as HTMLInputElement).value).toBe(DISPLAY_NAME);
      expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)).toBeNull();

      first.unmount();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/Governance action deposit/);
      expect(screen.queryByText(/^Restored your/)).toBeNull();
      // The remount's own restore effect finds nothing (storage was cleared
      // by discard) and dirty stays false, so nothing gets re-saved either.
      expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it('re-saves once a restored draft is edited', async () => {
      window.localStorage.setItem(DRAFT_KEY, storedDraft({ savedAt: Date.now() - 60_000 }));
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/^Restored your draft from/);

      // Restoring cleared dirty, so nothing has been written back yet.
      expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)?.title).toBe('Old title');

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Edited after restore' } });

      // The edit sets dirty back to true, so the persist effect saves again.
      await waitFor(
        () => expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)?.title).toBe('Edited after restore'),
        SLOW,
      );
    });

    it('writes no draft on a fresh visit with nothing edited', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/Governance action deposit/);
      expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)).toBeNull();
    });
  });
  // ------------------------------------------------------------------
  // Review modal. The model behind it is covered by previewModel.test.ts, so
  // these cover only what needs a DOM: the one round trip, the injection
  // boundary (server HTML in, everything else as text) and the modal's own
  // open/close behaviour. happy-dom's showModal() only flips `open`, so the
  // real focus trap and Tab order are not asserted here.
  // ------------------------------------------------------------------
  describe('review modal', () => {
    async function openReview() {
      const review = await screen.findByRole('button', { name: 'Review' });
      fireEvent.click(review);
      return review as HTMLButtonElement;
    }

    it('shows the server-rendered HTML under the abstract label', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await openReview();

      const abstractLabel = await screen.findByText('Abstract', { selector: 'p' }, SLOW);
      const body = abstractLabel.nextElementSibling as HTMLElement;
      expect(body.className).toContain('ga-abstract__body');
      expect(body.querySelector('strong')?.textContent).toBe('abstract');

      // One request for the three fields, nothing else.
      const previewCalls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.filter(
        ([url]) => String(url).includes('/api/preview'),
      );
      expect(previewCalls).toHaveLength(1);
    });

    it('renders markup typed into the title as text, never as an element', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.change(screen.getByLabelText('Title'), {
        target: { value: '<script>alert(1)</script>' },
      });
      await openReview();

      const heading = await screen.findByRole('heading', { name: '<script>alert(1)</script>' }, SLOW);
      expect(heading.querySelector('script')).toBeNull();
      expect(document.querySelector('dialog script')).toBeNull();
    });

    it('does not link a reference whose scheme the allowlist refuses', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      fireEvent.change(screen.getByLabelText('Reference 1 label'), { target: { value: 'Looks helpful' } });
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), { target: { value: 'javascript:alert(1)' } });
      await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect([...dialog.querySelectorAll('a')].map(a => a.getAttribute('href'))).not.toContain('javascript:alert(1)');
      expect(screen.queryByText('Looks helpful')).toBeNull();
    });

    it('renders markup in the author name as text', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.change(screen.getByLabelText('Author name'), {
        target: { value: '<img src=x onerror=alert(1)>' },
      });
      await openReview();

      await screen.findByText(
        'Author: <img src=x onerror=alert(1)>, will be signed with your wallet key when you submit',
        {},
        SLOW,
      );
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect(dialog.querySelector('img')).toBeNull();
    });

    it('renders markup in a reference label as text on an otherwise allowed link', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      fireEvent.change(screen.getByLabelText('Reference 1 label'), {
        target: { value: '"><img src=x onerror=alert(1)>' },
      });
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), {
        target: { value: 'https://example.com/paper' },
      });
      await openReview();

      // The URI is allowed, so the link IS rendered, and only the label has to be
      // a text node rather than the markup it looks like.
      const link = await screen.findByRole('link', { name: '"><img src=x onerror=alert(1)>' }, SLOW);
      expect(link.getAttribute('href')).toBe('https://example.com/paper');
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect(dialog.querySelector('img')).toBeNull();
      expect(dialog.querySelector('[onerror]')).toBeNull();
    });

    it('drops a data: reference, which the scheme allowlist refuses', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      fireEvent.change(screen.getByLabelText('Reference 1 label'), { target: { value: 'A data url' } });
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), {
        target: { value: 'data:text/html,x' },
      });
      await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect([...dialog.querySelectorAll('a')].map(a => a.getAttribute('href'))).not.toContain('data:text/html,x');
      expect(screen.queryByText('A data url')).toBeNull();
    });

    it('renders markup in a committee member name as text on the on-chain card', async () => {
      committeeContext = NAMED_COMMITTEE_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await fillCommitteePanel();
      await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      const dialog = document.querySelector('dialog') as HTMLElement;
      // The name reaches the card through the context, so it appears, and it
      // appears as the characters it is.
      expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(dialog.querySelector('img')).toBeNull();
      expect(dialog.querySelector('[onerror]')).toBeNull();
    });

    it('ignores a preview response that a newer one has already superseded', async () => {
      const first = deferred<Response>();
      const second = deferred<Response>();
      let call = 0;
      previewImpl = () => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      };

      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      const review = await openReview();
      await screen.findByText('Rendering the preview...', {}, SLOW);

      // Close, change the text, open again: request A is still in flight.
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await waitFor(() => expect(document.activeElement).toBe(review));
      fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: 'The new abstract' } });
      fireEvent.click(review);
      await screen.findByText('Rendering the preview...', {}, SLOW);

      // B answers first, then the stale A. The newer HTML has to survive.
      second.resolve(jsonResponse({ html: { abstract: '<p>NEW abstract</p>' } }));
      await screen.findByText('NEW abstract', {}, SLOW);
      first.resolve(jsonResponse({ html: { abstract: '<p>OLD abstract</p>' } }));

      await waitFor(() => expect(screen.queryByText('OLD abstract')).toBeNull());
      expect(screen.getByText('NEW abstract')).toBeTruthy();
    });

    it('renders no on-chain card for a committee payload that carries nothing', async () => {
      committeeContext = EMPTY_COMMITTEE_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('radio', { name: /Update committee/ }));
      await screen.findByText('There is no committee on record to remove members from.', {}, SLOW);
      await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      // Same gate the action page applies: no adds, no removes and no
      // threshold is no card at all, not an empty one.
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect(dialog.textContent).not.toContain('On-chain changes');
      // The missing list still explains itself: with no committee on record
      // there is no quorum to fall back to, so one has to be typed.
      expect(dialog.textContent).toContain('Quorum numerator');
    });

    it('lists what is still missing instead of refusing to preview', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Only a title' } });
      await openReview();

      const heading = await screen.findByText('Still missing', {}, SLOW);
      const items = [...(heading.parentElement as HTMLElement).querySelectorAll('li')].map(li => li.textContent);
      expect(items).toEqual(['Abstract', 'Motivation', 'Rationale']);
    });

    it('says the preview is unavailable and retries, leaving the form alone', async () => {
      previewImpl = async () => new Response('nope', { status: 500 });
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await openReview();

      await screen.findByText(/Preview unavailable, the form is unaffected/, {}, SLOW);
      previewImpl = null;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    });

    it('locks the page behind it while open and unlocks it on Edit, with focus back on Review', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      const review = await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      expect(document.body.style.overflow).toBe('hidden');

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await waitFor(() => expect(screen.queryByText('Preview, nothing is published yet')).toBeNull());
      expect(document.body.style.overflow).not.toBe('hidden');
      expect(document.activeElement).toBe(review);
    });

    it('closes on Escape and returns focus to the Review button', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      const review = await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      fireEvent.keyDown(document.querySelector('dialog') as HTMLElement, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByText('Preview, nothing is published yet')).toBeNull());
      expect(document.activeElement).toBe(review);
    });
  });

  describe('success screen sync poll', () => {
    beforeEach(() => {
      capturedPolls = [];
      startStatusPollingMock.mockClear();
    });

    /**
     * Submits the InfoAction form, waits for the success callout, and
     * returns the captured poll plus the render result's own unmount, so a
     * test can drive the cleanup half of the wiring.
     */
    async function submitAndReachSuccess(): Promise<{ poll: CapturedStatusPoll; unmount: () => void }> {
      const pollsBefore = capturedPolls.length;
      const view = render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await connect();
      const submit = screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement;
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);
      await screen.findByText('Proposal submitted', {}, SLOW);
      // >= pollsBefore + 1 (never reset between two submissions in the same
      // test, unlike beforeEach) rather than a fixed 1, so a test that mounts
      // a second island after the first still waits for its own new entry.
      await waitFor(() => expect(capturedPolls.length).toBeGreaterThan(pollsBefore), SLOW);
      return { poll: capturedPolls[capturedPolls.length - 1], unmount: view.unmount };
    }

    it('asks the status route for "<txHash>#0"', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'f'.repeat(64) });
      statusImpl = async () => jsonResponse({ synced: false, slug: null, draft: null });
      const fetchMock = installFetchMock();
      const { poll } = await submitAndReachSuccess();

      await poll.fetchStatus();
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/gov-action/status'));
      expect(String(call?.[0])).toContain(`id=${encodeURIComponent(`${'f'.repeat(64)}#0`)}`);
    });

    it('starts pending, then shows the thread link and the draft sentence once synced', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'f'.repeat(64) });
      const { poll } = await submitAndReachSuccess();

      act(() => poll.onUpdate({ kind: 'pending' }));
      // The interim state: the general explanation stays until the poll knows more.
      expect(screen.getByText(/appears in DRepTalk and on explorers only/)).toBeTruthy();
      expect(screen.queryByText('Your action is on DRepTalk')).toBeNull();

      act(() =>
        poll.onUpdate({
          kind: 'synced',
          slug: 'my-committee-change-ab12',
          draft: { slug: 'fund-tooling-c3d4', title: 'Fund tooling' },
        }),
      );

      expect(
        screen.getByRole('link', { name: 'Your action is on DRepTalk' }).getAttribute('href'),
      ).toBe('/t/my-committee-change-ab12/');
      const draftLink = screen.getByRole('link', { name: 'Fund tooling' });
      expect(draftLink.getAttribute('href')).toBe('/t/fund-tooling-c3d4/');
      expect(draftLink.parentElement?.textContent).toBe(
        'Linked to your Proposal Draft Fund tooling, the thread is now locked and the discussion continues on the action page.',
      );
    });

    it('shows the thread link with no draft sentence when no draft was linked', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'e'.repeat(64) });
      const { poll } = await submitAndReachSuccess();

      act(() => poll.onUpdate({ kind: 'synced', slug: 'my-info-action-cd34', draft: null }));

      expect(
        screen.getByRole('link', { name: 'Your action is on DRepTalk' }).getAttribute('href'),
      ).toBe('/t/my-info-action-cd34/');
      expect(screen.queryByText(/Linked to your Proposal Draft/)).toBeNull();
    });

    it('says the action is not synced yet once the ten minute window elapses', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'c'.repeat(64) });
      const { poll } = await submitAndReachSuccess();

      act(() => poll.onUpdate({ kind: 'timed-out' }));

      expect(screen.getByText(/Not synced yet/)).toBeTruthy();
      expect(
        screen.getByRole('link', { name: 'governance actions list' }).getAttribute('href'),
      ).toBe('/c/governance-actions/');
    });

    it('cancels the poll exactly once when the island unmounts', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'd'.repeat(64) });
      const { poll, unmount } = await submitAndReachSuccess();
      expect(poll.cancel).not.toHaveBeenCalled();

      unmount();

      expect(poll.cancel).toHaveBeenCalledTimes(1);
    });

    // DRepTalk is a multi-page Astro app, not a client-routed SPA, and the
    // success screen is terminal (its early return skips the form and the
    // "Use a different wallet" reset button, which only render pre-success):
    // there is no in-page control to submit a second proposal from the same
    // mounted island. A second submission is therefore always a fresh page
    // load, i.e. a fresh mount, which is exactly what this test drives: the
    // first mount's poll is torn down on unmount, and the second mount gets
    // its own independent poll for its own id, never reusing or extending
    // the first one.
    it('gives a fresh mount its own poll for its own id, independent of a prior submission', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'a'.repeat(64) });
      const fetchMock = installFetchMock();
      const first = await submitAndReachSuccess();
      first.unmount();
      expect(first.poll.cancel).toHaveBeenCalledTimes(1);

      submitGovActionMock.mockResolvedValue({ txHash: 'b'.repeat(64) });
      const second = await submitAndReachSuccess();

      expect(capturedPolls.length).toBe(2);
      expect(second.poll).not.toBe(first.poll);
      expect(second.poll.cancel).not.toHaveBeenCalled();

      await second.poll.fetchStatus();
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/gov-action/status'));
      expect(String(call?.[0])).toContain(`id=${encodeURIComponent(`${'b'.repeat(64)}#0`)}`);
    });
  });

  // Reload-safe island: a return to visibility after a while hidden refetches
  // the current type's context, a stale-looking reading says its own age, and
  // a refetch that moves a default the panel resolves against says which one
  // changed. Fake timers throughout: the component is mounted only after
  // `vi.useFakeTimers()`, and every wait is a manual `advanceTimersByTimeAsync`
  // flush rather than testing-library's `waitFor`/`findBy*`, which hang under
  // happy-dom once real timers are replaced (see the polling mock above).
  describe('reload-safe context (visibility, age, change notes)', () => {
    function contextCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
      return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/gov-action/context')).length;
    }

    /** Renders on NoConfidence (any chained type does) and flushes the initial context load. */
    async function mountOnNoConfidence() {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.click(screen.getByRole('radio', { name: /No confidence/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    /** Hides the tab, advances by `hiddenMs`, then shows it again, flushing any refetch it triggers. */
    async function hideThenShow(hiddenMs: number) {
      const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(hiddenMs);
      });
      hiddenSpy.mockReturnValue(false);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      hiddenSpy.mockRestore();
    }

    it('refetches the context once the tab was hidden more than 60 s', async () => {
      const fetchMock = installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        expect(screen.getByText('The sitting committee')).toBeTruthy();
        const before = contextCallCount(fetchMock);

        await hideThenShow(61_000);

        expect(contextCallCount(fetchMock)).toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not refetch when the tab was hidden 30 s or less', async () => {
      const fetchMock = installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        const before = contextCallCount(fetchMock);

        await hideThenShow(30_000);

        expect(contextCallCount(fetchMock)).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });

    // Finding 1 (Codex, review round 2): a visibility refetch racing the
    // submit's OWN freshness refetch could bump the request id the reducer
    // tracks, superseding the submit's request there, while `loadContext`
    // still handed its now-stale response back to `handleSubmit` regardless.
    // The fix gates the visibility refetch on `phase.status !== 'submitting'`
    // (checked through a ref, so the closure sees it live), which covers the
    // whole submit, not just the instant its own refetch is in flight. This
    // proves the gate itself, not just that a benign hide/show does nothing.
    it('never starts a background refetch while a submit is in flight, even after being hidden a long time', async () => {
      const fetchMock = installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        expect(screen.getByText('The sitting committee')).toBeTruthy();
        fillMetadata();

        fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        const submit = screen.getByRole('button', { name: 'Submit proposal' }) as HTMLButtonElement;
        expect(submit.disabled).toBe(false);

        const before = contextCallCount(fetchMock);
        const held = deferred<Response>();
        contextHold = held.promise;

        fireEvent.click(submit);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        // The submit's own freshness refetch has started (and is held open,
        // so it cannot resolve and move the submit past 'submitting' yet).
        expect(contextCallCount(fetchMock)).toBe(before + 1);

        await hideThenShow(61_000);

        // Still just the submit's own request: no background refetch snuck
        // in while phase was 'submitting', even though the tab was "hidden"
        // long enough that it otherwise would have started one.
        expect(contextCallCount(fetchMock)).toBe(before + 1);

        held.resolve(jsonResponse(committeeContext));
        contextHold = null;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows the chain context’s age once the reading is ten minutes old', async () => {
      installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        expect(screen.queryByText(/Chain context loaded/)).toBeNull();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10 * 60_000);
        });

        expect(screen.getByText('Chain context loaded 10 minutes ago')).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('says which default changed after a refetch moves it, and drops the note on the next edit', async () => {
      installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        expect(screen.getByText('The sitting committee')).toBeTruthy();

        committeeContext = {
          ...COMMITTEE_CONTEXT,
          committee: { ...COMMITTEE_CONTEXT.committee, quorum: { numerator: 3, denominator: 5 } },
        };
        await hideThenShow(61_000);

        expect(screen.getByText('The committee quorum changed to 3/5')).toBeTruthy();

        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'An edit' } });
        expect(screen.queryByText('The committee quorum changed to 3/5')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
