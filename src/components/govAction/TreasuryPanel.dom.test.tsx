// @vitest-environment happy-dom
// The treasury panel on its own: row editing, the per-row messages it shows
// for what the rules and the registration check report, the guardrail block,
// the twenty-row cap and the exact total.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TreasuryPanel from './TreasuryPanel.js';
import { encodeBech32 } from '@/lib/crypto/bech32.js';
import { hexToBytes } from '@/lib/crypto/hex.js';
import { NO_RECIPIENT_CHECK } from '@/lib/governance/govActionFormState.js';
import { GUARDRAIL_CHANGED_MESSAGE, GUARDRAIL_SCRIPT_HASH_HEX } from '@/lib/governance/guardrailScript.js';
import {
  RECIPIENT_UNREGISTERED,
  STAKE_ADDRESS_INVALID,
  TREASURY_RECIPIENTS_MAX,
} from '@/lib/governance/treasuryWithdrawals.js';

afterEach(cleanup);

const ADDR = encodeBech32('stake_test', hexToBytes(`e0${'ab'.repeat(28)}`));
const KNOWN = { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX } as const;

function panel(overrides: Partial<Parameters<typeof TreasuryPanel>[0]> = {}) {
  const onChange = vi.fn();
  const onRetryRecipients = vi.fn();
  render(
    <TreasuryPanel
      value={{ rows: [{ address: '', amountAda: '' }] }}
      onChange={onChange}
      network="preprod"
      guardrail={KNOWN}
      recipients={NO_RECIPIENT_CHECK}
      onRetryRecipients={onRetryRecipients}
      {...overrides}
    />,
  );
  return { onChange, onRetryRecipients };
}

describe('TreasuryPanel', () => {
  it('reports a typed address change and adds a row', () => {
    const { onChange } = panel();
    fireEvent.change(screen.getByLabelText('Recipient 1 stake address'), { target: { value: ADDR } });
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ address: ADDR, amountAda: '' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Add recipient' }));
    expect(onChange).toHaveBeenLastCalledWith({
      rows: [
        { address: '', amountAda: '' },
        { address: '', amountAda: '' },
      ],
    });
  });

  it('shows an address error only once something is typed', () => {
    panel({ value: { rows: [{ address: 'stake_test1nope', amountAda: '' }] } });
    expect(screen.getByText(STAKE_ADDRESS_INVALID)).toBeTruthy();
    cleanup();
    panel();
    expect(screen.queryByText(STAKE_ADDRESS_INVALID)).toBeNull();
  });

  it('shows the unregistered sentence and a retry for a failed check', () => {
    const { onRetryRecipients } = panel({
      value: { rows: [{ address: ADDR, amountAda: '1' }] },
      recipients: { requestId: 1, byAddress: { [ADDR]: 'unregistered' } },
    });
    expect(screen.getByText(RECIPIENT_UNREGISTERED)).toBeTruthy();
    cleanup();
    const second = panel({
      value: { rows: [{ address: ADDR, amountAda: '1' }] },
      recipients: { requestId: 1, byAddress: { [ADDR]: 'failed' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(second.onRetryRecipients).toHaveBeenCalledTimes(1);
    expect(onRetryRecipients).not.toHaveBeenCalled();
  });

  it('blocks with the changed sentence for a guardrail it does not ship', () => {
    panel({ guardrail: { state: 'known', scriptHash: 'ab'.repeat(28) } });
    expect(screen.getByRole('alert').textContent).toContain(GUARDRAIL_CHANGED_MESSAGE);
  });

  it('hides Add recipient at twenty rows', () => {
    panel({ value: { rows: Array.from({ length: TREASURY_RECIPIENTS_MAX }, () => ({ address: '', amountAda: '' })) } });
    expect(screen.queryByRole('button', { name: 'Add recipient' })).toBeNull();
  });

  it('keeps one empty row when the last row is removed', () => {
    const { onChange } = panel({ value: { rows: [{ address: ADDR, amountAda: '1' }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove recipient 1' }));
    expect(onChange).toHaveBeenLastCalledWith({ rows: [{ address: '', amountAda: '' }] });
  });

  it('shows the exact total', () => {
    panel({
      value: {
        rows: [
          { address: ADDR, amountAda: '1.000001' },
          { address: '', amountAda: '2' },
        ],
      },
    });
    expect(screen.getByText('Total 3.000001 tADA')).toBeTruthy();
  });
  describe('own stake address button', () => {
    const OWN = 'Add my wallet\'s stake address';
    const full = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ address: `stake_test1x${i}`, amountAda: '1' }));

    it('is absent without an own stake address', () => {
      panel();
      expect(screen.queryByRole('button', { name: OWN })).toBeNull();
    });

    it('fills the first empty row', () => {
      const { onChange } = panel({
        ownStakeAddress: ADDR,
        value: {
          rows: [
            { address: 'stake_test1abc', amountAda: '2' },
            { address: '  ', amountAda: '3' },
            { address: '', amountAda: '' },
          ],
        },
      });
      fireEvent.click(screen.getByRole('button', { name: OWN }));
      expect(onChange).toHaveBeenLastCalledWith({
        rows: [
          { address: 'stake_test1abc', amountAda: '2' },
          { address: ADDR, amountAda: '3' },
          { address: '', amountAda: '' },
        ],
      });
    });

    it('appends a row when none is empty', () => {
      const { onChange } = panel({
        ownStakeAddress: ADDR,
        value: { rows: [{ address: 'stake_test1abc', amountAda: '2' }] },
      });
      fireEvent.click(screen.getByRole('button', { name: OWN }));
      expect(onChange).toHaveBeenLastCalledWith({
        rows: [
          { address: 'stake_test1abc', amountAda: '2' },
          { address: ADDR, amountAda: '' },
        ],
      });
    });

    it('is hidden when the address is already listed, in any case', () => {
      panel({ ownStakeAddress: ADDR, value: { rows: [{ address: ADDR, amountAda: '1' }] } });
      expect(screen.queryByRole('button', { name: OWN })).toBeNull();
      cleanup();
      panel({ ownStakeAddress: ADDR, value: { rows: [{ address: ` ${ADDR.toUpperCase()}`, amountAda: '1' }] } });
      expect(screen.queryByRole('button', { name: OWN })).toBeNull();
    });

    it('is hidden at the row cap with no empty row but shown with an empty one', () => {
      panel({ ownStakeAddress: ADDR, value: { rows: full(TREASURY_RECIPIENTS_MAX) } });
      expect(screen.queryByRole('button', { name: OWN })).toBeNull();
      cleanup();
      const rows = full(TREASURY_RECIPIENTS_MAX);
      rows[3] = { address: '', amountAda: '' };
      panel({ ownStakeAddress: ADDR, value: { rows } });
      expect(screen.getByRole('button', { name: OWN })).toBeTruthy();
    });

    it('is disabled when the panel is disabled', () => {
      panel({ ownStakeAddress: ADDR, disabled: true });
      expect((screen.getByRole('button', { name: OWN }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('connect and add button', () => {
    const CONNECT = 'Connect wallet and add my stake address';
    const full = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ address: `stake_test1x${i}`, amountAda: '1' }));

    it('is shown before a wallet is connected and calls back', () => {
      const onConnectAndAddOwn = vi.fn();
      panel({ canConnectWallet: true, onConnectAndAddOwn });
      fireEvent.click(screen.getByRole('button', { name: CONNECT }));
      expect(onConnectAndAddOwn).toHaveBeenCalledTimes(1);
    });

    it('is hidden when no wallet can be connected', () => {
      panel({ canConnectWallet: false, onConnectAndAddOwn: vi.fn() });
      expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
    });

    it('is hidden once the wallet address is known', () => {
      panel({ canConnectWallet: true, onConnectAndAddOwn: vi.fn(), ownStakeAddress: ADDR });
      expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
    });

    it('is hidden at the row cap with no empty row', () => {
      panel({ canConnectWallet: true, onConnectAndAddOwn: vi.fn(), value: { rows: full(TREASURY_RECIPIENTS_MAX) } });
      expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
    });

    it('is disabled when the panel is disabled', () => {
      panel({ canConnectWallet: true, onConnectAndAddOwn: vi.fn(), disabled: true });
      expect((screen.getByRole('button', { name: CONNECT }) as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
