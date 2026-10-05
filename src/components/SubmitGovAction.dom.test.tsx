// @vitest-environment happy-dom
// The one DOM test for the submit island. Everything decidable without React
// is covered by the reducer and the leaf validators, so this test exists for
// exactly what those cannot reach: the effects and their dependency lists.
// Three things break silently if a dependency list is wrong, and all three are
// asserted here: a type switch must not touch the metadata or lose a panel, a
// remount must restore the whole form from storage (which means the save
// effect has to have written the panels and the type, not just the text), and
// a rejected submit must leave both the form and the stored draft alone.
//
// The environment is file-scoped on purpose: the node and workers test
// projects keep their own environments.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The submit path awaits several mocked round trips while the wallet hook
// keeps re-scanning on its own interval, so the default one second can be
// tight on a loaded machine. Generous, not slow: it resolves as soon as the
// condition holds.
const SLOW = { timeout: 5000 };
import SubmitGovAction from './SubmitGovAction.js';
import { loadGovActionDraft, govActionDraftKey } from '@/lib/governance/govActionDraft.js';

const submitGovActionMock = vi.fn();
vi.mock('@/lib/governance/govActionTx.js', () => ({
  submitGovAction: (...args: unknown[]) => submitGovActionMock(...args),
}));

const DRAFT_KEY = govActionDraftKey('preprod');
const MEMBER_A = 'a'.repeat(56);
const NEW_MEMBER = 'b'.repeat(56);
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Routes every request the island makes, so no test depends on a real network. */
function installFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/koios/epoch_params')) return jsonResponse([EPOCH_PARAMS_ROW]);
    if (url.includes('/api/gov-action/context')) return jsonResponse(COMMITTEE_CONTEXT);
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
    signData: vi.fn(),
    signTx: vi.fn(),
    submitTx: vi.fn(),
  };
  (window as unknown as { cardano: unknown }).cardano = {
    testwallet: { name: 'Test Wallet', icon: '', enable: vi.fn(async () => api) },
  };
  return api;
}

/** Connects the wallet and waits for the form to appear. */
async function connect() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));
  await screen.findByLabelText('Title');
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
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(MEMBER_A.slice(0, 12)) }));
  fireEvent.click(screen.getByRole('button', { name: 'Add a member' }));
  fireEvent.change(screen.getByLabelText('Credential to add 1'), { target: { value: NEW_MEMBER } });
  fireEvent.change(screen.getByLabelText('Expiry epoch for addition 1'), { target: { value: '560' } });
}

describe('SubmitGovAction', () => {
  beforeEach(() => {
    window.localStorage.clear();
    submitGovActionMock.mockReset();
    installFetchMock();
    installWalletMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps the metadata across a type switch and restores the panel on the way back', async () => {
    render(<SubmitGovAction network="preprod" />);
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
    expect((screen.getByRole('checkbox', { name: new RegExp(MEMBER_A.slice(0, 12)) }) as HTMLInputElement).checked).toBe(true);
  });

  it('restores the type, the metadata and the panel from storage after a remount', async () => {
    const first = render(<SubmitGovAction network="preprod" />);
    await connect();
    fillMetadata();
    await fillCommitteePanel();
    await waitFor(() => expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)?.type).toBe('UpdateCommittee'), SLOW);
    first.unmount();

    render(<SubmitGovAction network="preprod" />);
    await connect();
    expect((screen.getByRole('radio', { name: /Update committee/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    await screen.findByLabelText('Credential to add 1');
    expect((screen.getByLabelText('Credential to add 1') as HTMLInputElement).value).toBe(NEW_MEMBER);
    expect((screen.getByLabelText('Quorum numerator') as HTMLInputElement).value).toBe('2');
  });

  it('leaves the form and the draft intact when the transaction is rejected', async () => {
    submitGovActionMock.mockRejectedValue(new Error('user declined the transaction'));
    render(<SubmitGovAction network="preprod" />);
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
});
