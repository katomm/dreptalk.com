// @vitest-environment happy-dom
// More DOM tests for the submit island, split off SubmitGovAction.dom.test.tsx
// so vitest runs them in parallel. Why these tests exist is explained there.
// The environment is file-scoped on purpose: the node and workers test
// projects keep their own environments.
//
// The shared mocks and helpers live in __fixtures__/submitGovActionHarness.ts.
// This file: treasury withdrawals and a guardrail that moved since the form loaded.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SubmitGovAction from './SubmitGovAction.js';
import { loadGovActionDraft } from '@/lib/governance/govActionDraft.js';
import { GUARDRAIL_CHANGED_MESSAGE, GUARDRAIL_REQUIREMENT_CHANGED_MESSAGE, GUARDRAIL_SCRIPT_HASH_HEX, GUARDRAIL_UNKNOWN_MESSAGE } from '@/lib/governance/guardrailScript.js';
import { RECIPIENT_UNREGISTERED, RECIPIENTS_CHECK_FAILED_AT_SUBMIT } from '@/lib/governance/treasuryWithdrawals.js';
import { EVALUATION_FAILED_MESSAGE } from '@/lib/governance/govActionErrors.js';
import {
  useSubmitGovActionHarness,
  SLOW,
  submitGovActionMock,
  DRAFT_KEY,
  DISPLAY_NAME,
  REWARD_STAKE_ADDRESS,
  RECIPIENT_HEX,
  RECIPIENT,
  TREASURY_CONTEXT,
  PARAM_CONTEXT,
  installFetchMock,
  installWalletMock,
  walletEntry,
  connect,
  signButton,
  fillMetadata,
  fillTreasuryPanel,
  fillParamPanel,
  requestsTo,
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

  describe('treasury withdrawals', () => {
    it('submits a treasury withdrawal with the checked guardrail and the registered recipient', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillTreasuryPanel();

      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      const opts = submitGovActionMock.mock.calls[0][0] as { action: unknown };
      expect(opts.action).toEqual({
        type: 'TreasuryWithdrawals',
        withdrawals: [{ rewardAddressHex: RECIPIENT_HEX, lovelace: 1_000_000n }],
        guardrail: { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX },
      });
    });

    it('adds the connected wallet\'s stake address as a recipient', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.click(await screen.findByRole('radio', { name: /Treasury withdrawal/ }, SLOW));
      await screen.findByLabelText('Recipient 1 stake address', {}, SLOW);
      expect(screen.queryByRole('button', { name: "Add my wallet's stake address" })).toBeNull();
      await connect();
      fireEvent.click(await screen.findByRole('button', { name: "Add my wallet's stake address" }, SLOW));
      const own = REWARD_STAKE_ADDRESS;
      expect((screen.getByLabelText('Recipient 1 stake address') as HTMLInputElement).value).toBe(own);
    });

    it('connects the only installed wallet from the recipient panel and fills its stake address', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.click(await screen.findByRole('radio', { name: /Treasury withdrawal/ }, SLOW));
      await screen.findByLabelText('Recipient 1 stake address', {}, SLOW);
      fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet and add my stake address' }, SLOW));
      const own = REWARD_STAKE_ADDRESS;
      await waitFor(
        () => expect((screen.getByLabelText('Recipient 1 stake address') as HTMLInputElement).value).toBe(own),
        SLOW,
      );
      expect(screen.queryByRole('button', { name: 'Connect wallet and add my stake address' })).toBeNull();
    });

    it('fills nothing and shows the wallet step error when the connect fails', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.click(await screen.findByRole('radio', { name: /Treasury withdrawal/ }, SLOW));
      await screen.findByLabelText('Recipient 1 stake address', {}, SLOW);
      walletEntry().enable.mockRejectedValueOnce(new Error('User declined'));
      fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet and add my stake address' }, SLOW));
      await screen.findByText(/declined/i, {}, SLOW);
      expect((screen.getByLabelText('Recipient 1 stake address') as HTMLInputElement).value).toBe('');
    });

    it('points to the wallet picker instead of connecting when several wallets are installed', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      const api = installWalletMock();
      const cardano = (window as unknown as { cardano: Record<string, unknown> }).cardano;
      const second = { name: 'Other Wallet', icon: '', enable: vi.fn(async () => api) };
      cardano.otherwallet = second;
      const scrollIntoView = vi.fn();
      const originalScroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrollIntoView;
      try {
        render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
        fireEvent.click(await screen.findByRole('radio', { name: /Treasury withdrawal/ }, SLOW));
        await screen.findByLabelText('Recipient 1 stake address', {}, SLOW);
        await screen.findByRole('button', { name: 'Change wallet' }, SLOW);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect wallet and add my stake address' }, SLOW));
        await waitFor(() => expect(scrollIntoView).toHaveBeenCalled(), SLOW);
        expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Test Wallet/ }));
        expect((walletEntry() as { enable: ReturnType<typeof vi.fn> }).enable).not.toHaveBeenCalled();
        expect(second.enable).not.toHaveBeenCalled();
      } finally {
        Element.prototype.scrollIntoView = originalScroll;
        delete (window as unknown as { cardano: Record<string, unknown> }).cardano.otherwallet;
      }
    });

    it('checks an address typed in uppercase under its lowercase form and lets it through', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      const fetchMock = installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillTreasuryPanel(RECIPIENT.toUpperCase());

      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      const recipientLookups = fetchMock.mock.calls
        .filter(([input]) => String(input).includes('/api/koios/account_info'))
        .map(([, init]) => (JSON.parse(String(init?.body)) as { _stake_addresses: string[] })._stake_addresses)
        .filter((addresses) => addresses.includes(RECIPIENT));
      expect(recipientLookups.length).toBeGreaterThan(0);
      for (const addresses of recipientLookups) expect(addresses).toEqual([RECIPIENT]);
    });

    it('blocks when the guardrails script changed after the form loaded, before anything is signed or pinned', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      const fetchMock = installFetchMock();
      const api = installWalletMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillTreasuryPanel();
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);

      mocks.committeeContext = { epoch: 500, guardrail: { state: 'known', scriptHash: 'ab'.repeat(28) } };
      fireEvent.click(submit);

      expect((await screen.findAllByText(GUARDRAIL_CHANGED_MESSAGE, {}, SLOW)).length).toBeGreaterThan(0);
      expect(submitGovActionMock).not.toHaveBeenCalled();
      expect(api.signData).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/gov-action/metadata'))).toBe(false);
    });

    it('keeps submit disabled for an unregistered recipient and says why', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      mocks.recipientStatus.set(RECIPIENT, 'not registered');
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillTreasuryPanel();

      expect((await screen.findAllByText(RECIPIENT_UNREGISTERED, {}, SLOW)).length).toBeGreaterThan(0);
      expect(signButton().disabled).toBe(true);
    });

    it('re-reads registration at submit and stops when a recipient is no longer registered', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillTreasuryPanel();
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);

      mocks.recipientStatus.set(RECIPIENT, 'not registered');
      fireEvent.click(submit);

      expect((await screen.findAllByText(RECIPIENT_UNREGISTERED, {}, SLOW)).length).toBeGreaterThan(0);
      expect(submitGovActionMock).not.toHaveBeenCalled();
    });

    it('stops without signing when the registration lookup fails at submit', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      const fetchMock = installFetchMock();
      const api = installWalletMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillTreasuryPanel();
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);

      mocks.accountInfoFails = true;
      fireEvent.click(submit);

      expect((await screen.findAllByText(RECIPIENTS_CHECK_FAILED_AT_SUBMIT, {}, SLOW)).length).toBeGreaterThan(0);
      expect(submitGovActionMock).not.toHaveBeenCalled();
      expect(api.signData).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/gov-action/metadata'))).toBe(false);
    });

    it('says the guardrails script could not be checked when the context answers guardrail_unknown', async () => {
      mocks.contextError = { error: 'guardrail_unknown' };
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.click(await screen.findByRole('radio', { name: /Treasury withdrawal/ }));
      expect(await screen.findByText(GUARDRAIL_UNKNOWN_MESSAGE, {}, SLOW)).toBeTruthy();
    });

    it('words a guardrail rejection and shows the script error in a disclosure', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      const inner = Object.assign(new Error('Script evaluation failed'), {
        cause: { code: 'evaluation_failed', detail: 'Validator returned False' },
      });
      submitGovActionMock.mockRejectedValue(
        Object.assign(new Error('Script evaluation failed: evaluation_failed'), { cause: inner }),
      );
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillTreasuryPanel();
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      expect(await screen.findByText(EVALUATION_FAILED_MESSAGE, { exact: false }, SLOW)).toBeTruthy();
      expect(screen.getByText('Validator returned False')).toBeTruthy();
    });

    it('restores a treasury draft and checks its recipients again', async () => {
      mocks.committeeContext = TREASURY_CONTEXT;
      const first = render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await fillTreasuryPanel();
      await waitFor(() => expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)?.type).toBe('TreasuryWithdrawals'), SLOW);
      first.unmount();

      mocks.recipientStatus.set(RECIPIENT, 'not registered');
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      expect(((await screen.findByLabelText('Recipient 1 stake address', {}, SLOW)) as HTMLInputElement).value).toBe(RECIPIENT);
      expect((await screen.findAllByText(RECIPIENT_UNREGISTERED, {}, SLOW)).length).toBeGreaterThan(0);
    });

  });
  describe('guardrail moved since the form loaded', () => {
    const KNOWN = { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX };
    const ABSENT = { state: 'absent' };

    /**
     * Loads the form with one guardrail state, fills the type's panel, then
     * answers the submit's own refetch with the other state. Both are
     * buildable on their own, only the comparison with the shown one stops it,
     * with the message that asks for a second look rather than the one about
     * a script DRepTalk does not know.
     */
    async function guardrailMoves(type: 'ParameterChange' | 'TreasuryWithdrawals', from: unknown, to: unknown) {
      const contextFor = (guardrail: unknown) =>
        type === 'ParameterChange' ? { ...PARAM_CONTEXT, guardrail } : { epoch: 500, guardrail };
      mocks.committeeContext = contextFor(from);
      const fetchMock = installFetchMock();
      const api = installWalletMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      if (type === 'ParameterChange') await fillParamPanel({ k: '600' });
      else await fillTreasuryPanel();
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);

      mocks.committeeContext = contextFor(to);
      fireEvent.click(submit);

      expect((await screen.findAllByText(GUARDRAIL_REQUIREMENT_CHANGED_MESSAGE, {}, SLOW)).length).toBeGreaterThan(0);
      expect(screen.queryByText(GUARDRAIL_CHANGED_MESSAGE)).toBeNull();
      expect(submitGovActionMock).not.toHaveBeenCalled();
      expect(api.signData).not.toHaveBeenCalled();
      expect(requestsTo(fetchMock, '/api/gov-action/metadata')).toBe(0);
    }

    it('stops a parameter change before signing when the guardrail moved from known to absent', async () => {
      await guardrailMoves('ParameterChange', KNOWN, ABSENT);
    });

    it('stops a parameter change before signing when the guardrail moved from absent to known', async () => {
      await guardrailMoves('ParameterChange', ABSENT, KNOWN);
    });

    it('stops a treasury withdrawal before signing when the guardrail moved from known to absent', async () => {
      await guardrailMoves('TreasuryWithdrawals', KNOWN, ABSENT);
    });

    it('stops a treasury withdrawal before signing when the guardrail moved from absent to known', async () => {
      await guardrailMoves('TreasuryWithdrawals', ABSENT, KNOWN);
    });
  });
});
