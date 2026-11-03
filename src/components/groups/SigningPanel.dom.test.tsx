// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const submitTx = vi.fn(async (_tx: string) => 'e'.repeat(64));
const WALLET = {
  key: 'w',
  name: 'Test wallet',
  icon: '',
  supportsCip95: true,
  raw: { name: 'Test wallet', icon: '', enable: async () => ({ getNetworkId: async () => 0, submitTx }) },
};
let walletList: unknown[] = [];
vi.mock('@/lib/wallet/useCardanoWallets.js', () => ({
  useCardanoWallets: () => ({ wallets: walletList, selected: 'w', setSelected: () => {} }),
  rememberWallet: () => {},
}));
vi.mock('@/lib/wallet/networkGuard.js', () => ({ assertWalletNetwork: async () => {} }));

import SigningPanel, { type ActionView } from './SigningPanel.js';

const REQ = 'a'.repeat(56);
const OPT = 'b'.repeat(56);

const base: ActionView = {
  id: 'x',
  kind: 'group_update',
  status: 'collecting',
  resolution: null,
  groupId: 'group1',
  lines: ['Change the control policy of the group.'],
  requiredSigners: [REQ],
  signed: [],
  optionalSigned: [OPT],
  satisfied: false,
  expiresAt: 2_000_000_000,
  unsignedTxCbor: '00',
  bodyHash: 'c'.repeat(64),
  canSubmit: false,
  isInitiator: true,
  feeInputs: [{ txHash: 'd'.repeat(64), index: 0 }],
};

function show(view: Partial<ActionView>, extra: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, ...view, ...extra })));
  render(<SigningPanel actionId="x" network="preprod" />);
}

afterEach(() => {
  walletList = [];
  submitTx.mockClear();
  cleanup();
  vi.unstubAllGlobals();
});

describe('SigningPanel', () => {
  it('renders the lines the API sends and never intent text', async () => {
    show({}, { actionParams: { kind: 'group_dissolve' }, intentText: 'Dissolve everything' });
    expect(await screen.findByText('Change the control policy of the group.')).toBeTruthy();
    expect(screen.queryByText(/Dissolve everything/)).toBeNull();
  });

  it('shows mandatory signers apart from optional ones', async () => {
    show({});
    await screen.findByText('Must sign');
    expect(screen.getByText(/aaaaaaaa\.\.\.aaaaaa \(waiting\)/)).toBeTruthy();
    expect(screen.getByText('May sign, already signed')).toBeTruthy();
    expect(screen.getByText(/bbbbbbbb\.\.\.bbbbbb \(signed\)/)).toBeTruthy();
  });

  it('hides submit until canSubmit', async () => {
    show({ canSubmit: false });
    await screen.findByText('Must sign');
    expect(screen.queryByRole('button', { name: 'Submit transaction' })).toBeNull();
    cleanup();
    show({ canSubmit: true, satisfied: true, signed: [REQ] });
    expect(await screen.findByRole('button', { name: 'Submit transaction' })).toBeTruthy();
  });

  it('shows confirming after submit and the resolution after it', async () => {
    show({ status: 'submitted' });
    expect(await screen.findByText(/waiting for the chain to confirm/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit transaction' })).toBeNull();
    cleanup();
    show({ status: 'submitted', resolution: 'applied' });
    expect(await screen.findByText(/group change is in effect/)).toBeTruthy();
    expect(screen.queryByText(/waiting for the chain/)).toBeNull();
  });

  it('warns that handed out signatures stay usable and offers the real cancellation', async () => {
    show({});
    expect(await screen.findByText(/stay usable until the expiry/)).toBeTruthy();
    cleanup();
    show({ status: 'cancelled' });
    expect(await screen.findByRole('button', { name: 'Cancel for real' })).toBeTruthy();
  });

  it('hides cancel from a signer who is not the initiator', async () => {
    show({ isInitiator: false, feeInputs: [] });
    await screen.findByText('Must sign');
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  it('shows a plain refusal and no content on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not a signer of this action' }, { status: 403 })));
    render(<SigningPanel actionId="x" network="preprod" />);
    await waitFor(() => expect(screen.getByText(/not available to your login/)).toBeTruthy());
  });

  it('keeps polling after a 503 and shows the action once it answers', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (n++ === 0 ? Response.json({ error: 'service unavailable' }, { status: 503 }) : Response.json(base))),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<SigningPanel actionId="x" network="preprod" />);
      expect(await screen.findByText(/service unavailable/)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(4100);
      expect(await screen.findByText('Must sign')).toBeTruthy();
      expect(screen.queryByText(/service unavailable/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('assembles, submits with the wallet and records the hash', async () => {
    walletList = [WALLET];
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/submit')) return Response.json({ assembledTxHex: 'abcd' });
        if (url.endsWith('/submitted')) return new Response('boom', { status: 500 });
        return Response.json({ ...base, canSubmit: true, satisfied: true, signed: [REQ] });
      }),
    );
    render(<SigningPanel actionId="x" network="preprod" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Submit transaction' }));
    await waitFor(() => expect(submitTx).toHaveBeenCalledWith('abcd'));
    expect(await screen.findByText(/Recording it failed/)).toBeTruthy();
    const order = calls.filter((u) => /\/(submit|submitted)$/.test(u)).map((u) => u.split('/').pop());
    expect(order).toEqual(['submit', 'submitted']);
  });
});
