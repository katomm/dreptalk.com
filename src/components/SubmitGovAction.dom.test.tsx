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
//
// The shared mocks and helpers live in __fixtures__/submitGovActionHarness.ts.
// This file: the form itself, the wallet step and the deposit.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SubmitGovAction from './SubmitGovAction.js';
import { loadGovActionDraft } from '@/lib/governance/govActionDraft.js';
import { ccColdBech32 } from '@/lib/governance/committeeUpdate.js';
import {
  useSubmitGovActionHarness,
  SLOW,
  submitGovActionMock,
  type MockUtxos,
  deferred,
  DRAFT_KEY,
  DISPLAY_NAME,
  MEMBER_A,
  NEW_MEMBER,
  SCRIPT_MEMBER,
  REWARD_ADDRESS,
  OPEN_COMMITTEE_CONTEXT,
  installFetchMock,
  installWalletMock,
  walletEntry,
  connect,
  signButton,
  fillMetadata,
  fillCommitteePanel,
  mocks,
} from './__fixtures__/submitGovActionHarness.js';

vi.mock('@/lib/governance/govActionTx.js', async () => (await import('./__fixtures__/submitGovActionHarness.js')).govActionTxMock());
vi.mock('@/lib/governance/successPolling.js', async importOriginal =>
  (await import('./__fixtures__/submitGovActionHarness.js')).successPollingMock(await importOriginal()),
);
vi.mock('@/lib/governance/walletUtxos.js', async importOriginal =>
  (await import('./__fixtures__/submitGovActionHarness.js')).walletUtxosMock(await importOriginal()),
);

describe('SubmitGovAction', () => {
  useSubmitGovActionHarness();

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
    // the panel validates, so waiting on it is what lets the click through.
    const submit = signButton();
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
    mocks.committeeContext = OPEN_COMMITTEE_CONTEXT;
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

    const submit = signButton();
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
    expect(signButton().disabled).toBe(true);
  });

  it('opens the review for any submit that did not come from Sign and submit', async () => {
    installFetchMock();
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    await connect();
    fillMetadata();
    await fillCommitteePanel();
    await waitFor(() => expect(screen.queryByText('Before you can submit')).toBeNull(), SLOW);

    // The form has no submit button, so a browser sends no implicit
    // submission on Enter. Anything that submits it anyway is routed to the
    // review, never straight to signing.
    fireEvent.submit(screen.getByLabelText('Title').closest('form') as HTMLFormElement);

    const sign = await screen.findByRole('button', { name: 'Sign and submit' });
    expect((sign as HTMLButtonElement).disabled).toBe(false);
    expect(submitGovActionMock).not.toHaveBeenCalled();
  });

  it('names what is missing inside the review, next to a disabled Sign and submit', async () => {
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await fillCommitteePanel();

    const sign = signButton();
    expect(sign.disabled).toBe(true);
    const dialog = sign.closest('dialog') as HTMLElement;
    await waitFor(() => expect(dialog.textContent).toContain('Connect a wallet'));
  });

  it('previews a field the way the action page renders it, without forum @mention links', async () => {
    const fetchMock = installFetchMock();
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fireEvent.change(await screen.findByLabelText('Abstract'), { target: { value: 'Hi @someone' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0]);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/preview'));
      expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({ parts: { body: 'Hi @someone' } });
    });
  });

  it('offers the Markdown toolbar on the three text fields, without @mentions', async () => {
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    await screen.findByLabelText('Abstract');
    expect(screen.getAllByRole('toolbar', { name: 'Markdown formatting' })).toHaveLength(3);
    expect(screen.queryByTitle('Mention someone')).toBeNull();
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
    mocks.walletLovelace = 900_000_000n;
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await fillCommitteePanel();
    await connect();

    await screen.findByText(
      'The wallet holds 900 tADA, the deposit plus a 5 tADA fee reserve needs 100,005',
      {},
      SLOW,
    );
    const submit = signButton();
    expect(submit.disabled).toBe(true);

    mocks.walletLovelace = 200_000_000_000n;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText(/The wallet holds/)).toBeNull(), SLOW);
    await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
  });

  it('stops on an unregistered refund address and clears after registering and checking again', async () => {
    mocks.stakeStatus = 'not registered';
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await fillCommitteePanel();
    await connect();

    await screen.findByText(/stake key is not registered/, {}, SLOW);
    const submit = signButton();
    expect(submit.disabled).toBe(true);

    mocks.stakeStatus = 'registered';
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText(/stake key is not registered/)).toBeNull(), SLOW);
    await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
  });

  it('files a slow balance read against the wallet it was started for, not the next one', async () => {
    const slow = deferred<MockUtxos>();
    mocks.collectWalletUtxosImpl = () => slow.promise;
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    await screen.findByText('Reading the wallet balance...', {}, SLOW);

    // The user gives up on that wallet and connects another one, which answers
    // at once.
    fireEvent.click(screen.getByRole('button', { name: 'Use a different wallet' }));
    mocks.collectWalletUtxosImpl = null;
    mocks.walletLovelace = 200_000_000_000n;
    await connect();

    // The first wallet's read comes back last, and with a balance that would
    // block the submit if it were filed against the wallet now connected.
    slow.resolve([{ assets: { lovelace: 900_000_000n } }]);
    await waitFor(() => expect(submitGovActionMock).not.toHaveBeenCalled());
    expect(screen.getByText('Deposit 100,000 tADA, wallet 200,000 tADA')).toBeTruthy();
    expect(screen.queryByText(/The wallet holds/)).toBeNull();
    expect(signButton().disabled).toBe(false);
  });

  it('says the balance read failed instead of claiming to still be reading', async () => {
    mocks.collectWalletUtxosImpl = async () => {
      throw new Error('Koios is down');
    };
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    await screen.findByText('Could not read the wallet balance, check again', {}, SLOW);
    expect(screen.queryByText('Reading the wallet balance...')).toBeNull();
    expect(screen.getByText(/Koios is down/)).toBeTruthy();
    expect(signButton().disabled).toBe(true);
  });

  it('lets the browser reject an invalid reference URL before anything is published', async () => {
    const fetchMock = installFetchMock();
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await connect();

    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
    fireEvent.change(screen.getByLabelText('Reference 1 label'), { target: { value: 'The discussion' } });
    fireEvent.change(screen.getByLabelText('Reference 1 URL'), { target: { value: 'not a url' } });

    const submit = signButton();
    // Readiness has nothing against it: the URL rule is the browser's.
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(submitGovActionMock).not.toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gov-action/metadata'))).toBe(false);

    // The failed validation closed the review. Once the URL is one, the same
    // review and sign goes through.
    fireEvent.change(screen.getByLabelText('Reference 1 URL'), { target: { value: 'https://example.org/thread' } });
    fireEvent.click(signButton());
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
    expect(signButton().disabled).toBe(true);
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

  describe('on mainnet', () => {
    const MAINNET_REWARD = 'e1'.concat('c'.repeat(56));

    async function connectMainnet() {
      const api = installWalletMock();
      api.getNetworkId.mockResolvedValue(1);
      api.getRewardAddresses.mockResolvedValue([MAINNET_REWARD]);
      mocks.walletLovelace = 200_000_000_000n;
      render(<SubmitGovAction network="mainnet" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await connect();
    }

    function ack(): HTMLInputElement {
      return screen.getByRole('checkbox', { name: /^I understand that submitting locks 100,000 ada until the action is finalized\.$/ }) as HTMLInputElement;
    }

    it('writes ada, never tADA', async () => {
      await connectMainnet();
      expect(screen.getByText('Deposit 100,000 ada, wallet 200,000 ada')).toBeTruthy();
      expect(screen.queryByText(/tADA/)).toBeNull();
    });

    it('keeps Sign and submit disabled until the deposit is acknowledged, and asks again on reopen', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'a'.repeat(64) });
      await connectMainnet();
      const submit = signButton();
      expect(ack().checked).toBe(false);
      expect(submit.disabled).toBe(true);

      fireEvent.click(ack());
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const reopened = signButton();
      expect(ack().checked).toBe(false);
      expect(reopened.disabled).toBe(true);

      fireEvent.click(ack());
      await waitFor(() => expect(reopened.disabled).toBe(false), SLOW);
      fireEvent.click(reopened);
      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      expect(submitGovActionMock.mock.calls[0][0]).toEqual(expect.objectContaining({ network: 'mainnet' }));
    });

    it('says an empty wallet holds no ada, without the Preview hint', async () => {
      submitGovActionMock.mockRejectedValue(new Error('Insufficient funds for the deposit: need 100005000000 lovelace, wallet has 0.'));
      await connectMainnet();
      const submit = signButton();
      fireEvent.click(ack());
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);
      expect(await screen.findByText('This wallet holds no ada.', {}, SLOW)).toBeTruthy();
      expect(screen.queryByText(/Preview wallet/)).toBeNull();
    });
  });

  it('asks for no deposit acknowledgement on preprod', async () => {
    installFetchMock();
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();
    await connect();
    signButton();
    expect(screen.queryByRole('checkbox', { name: /I understand that submitting locks/ })).toBeNull();
  });
});
