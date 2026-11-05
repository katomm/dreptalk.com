// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const submitTx = vi.fn(async (_tx: string) => 'e'.repeat(64));
const signTx = vi.fn(async (_tx: string, _partial: boolean) => 'a0');
const WALLET = {
  key: 'w',
  name: 'Test wallet',
  icon: '',
  supportsCip95: true,
  raw: { name: 'Test wallet', icon: '', enable: async () => ({ getNetworkId: async () => 0, submitTx, signTx }) },
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
  viewerKey: REQ,
  names: { [REQ]: 'Alice', [OPT]: 'Bob' },
  fundingSigned: false,
};

function show(view: Partial<ActionView>, extra: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, ...view, ...extra })));
  render(<SigningPanel actionId="x" network="preprod" />);
}

afterEach(() => {
  walletList = [];
  submitTx.mockClear();
  signTx.mockClear();
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
    expect(screen.getByText('Alice').nextSibling?.textContent).toBe('Waiting');
    expect(screen.getByText('May sign, already signed')).toBeTruthy();
    expect(screen.getByText('Bob').nextSibling?.textContent).toBe('Signed');
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
      expect(await screen.findByText(/service unavailable/i)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(4100);
      expect(await screen.findByText('Must sign')).toBeTruthy();
      expect(screen.queryByText(/service unavailable/i)).toBeNull();
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

  it('shows an unmistakable success after signing, says what is missing and offers no second signature', async () => {
    walletList = [WALLET];
    const OTHER = 'c'.repeat(56);
    let signed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/witness')) {
          signed = true;
          return Response.json({ accepted: [REQ], ignored: [], satisfied: false });
        }
        return Response.json({ ...base, requiredSigners: [REQ, OTHER], signed: signed ? [REQ] : [], fundingSigned: true, names: { ...base.names, [OTHER]: 'Carol' } });
      }),
    );
    render(<SigningPanel actionId="x" network="preprod" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign with wallet' }));
    expect(await screen.findByText('Not finished: waiting for 1 more signature')).toBeTruthy();
    expect(screen.getByText(/Your signature was added\. Carol has to sign before anyone can submit the transaction\./)).toBeTruthy();
    expect(screen.getByText(/Share this signing link with them: .*\/groups\/sign\/x\//)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByText('Signature added')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit transaction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign with wallet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add signature' })).toBeNull();
  });

  it('keeps the signed state for a signer who comes back to the page', async () => {
    walletList = [WALLET];
    show({ signed: [REQ], satisfied: true, canSubmit: true, fundingSigned: true });
    expect(await screen.findByText('You have signed')).toBeTruthy();
    expect(screen.getByText(/The transaction can be submitted now/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign with wallet' })).toBeNull();
  });

  it('offers the initiator the fee signature after the DRep signature', async () => {
    walletList = [WALLET];
    show({ signed: [REQ], fundingSigned: false });
    expect(await screen.findByText(/initiator still has to sign for the fee/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign for the fee' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign with wallet' })).toBeTruthy();
  });

  it('tells a DRep whose key is not a signer so and offers no signing', async () => {
    walletList = [WALLET];
    show({ viewerKey: 'f'.repeat(56), isInitiator: false, feeInputs: [] });
    expect(await screen.findByText(/Your DRep key is not a signer of this transaction/)).toBeTruthy();
    expect(screen.getByText(/chosen when it was built: Alice\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign with wallet' })).toBeNull();
  });

  it('says a transaction whose coin another transaction spent can no longer be submitted and offers no signing', async () => {
    walletList = [WALLET];
    show({ feeInputSpent: true, signed: [REQ], satisfied: true, canSubmit: false, fundingSigned: false });
    expect(
      await screen.findByText(
        'This transaction can no longer be submitted, a coin it spends was used by another transaction. Cancel it and start it again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign with wallet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit transaction' })).toBeNull();
    expect(screen.queryByText(/stay usable until the expiry/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel this signing link' })).toBeTruthy();
    cleanup();
    // Once resolved never included it names the cause instead of the expiry, and offers nothing.
    show({ feeInputSpent: true, resolution: 'never_included' });
    expect(await screen.findByText(/a coin it spends was used by another transaction\. Start it again if you still want this change\./)).toBeTruthy();
    expect(screen.queryByText(/its time ran out/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel|Sign/ })).toBeNull();
  });

  it('offers no real cancellation once the fee input is spent', async () => {
    show({ status: 'cancelled', feeInputSpent: true });
    expect(await screen.findByText(/This signing link was cancelled\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel for real' })).toBeNull();
  });

  it('shows the server reason of a refused signature in one sentence', async () => {
    walletList = [WALLET];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/witness')
          ? Response.json({ error: 'None of the keys of this signature is a signer of this action.' }, { status: 422 })
          : Response.json(base),
      ),
    );
    render(<SigningPanel actionId="x" network="preprod" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign with wallet' }));
    expect(await screen.findByText('Could not add the signature. None of the keys of this signature is a signer of this action.')).toBeTruthy();
  });
});
