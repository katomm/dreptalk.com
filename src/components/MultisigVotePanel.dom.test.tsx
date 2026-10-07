// @vitest-environment happy-dom
// The initiate flow loads the DRep's native script through the session-gated
// server route. The public Koios proxy does not forward script_info, so a
// request to it ends in 403 and the flow could never start.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { nativeScriptHash, parseNativeScriptJson } from '@/lib/cardano/nativeScript';
import { encodeBech32 } from '@/lib/crypto/bech32';
import { hexToBytes } from '@/lib/crypto/hex';
import { DREP_SCRIPT_HEADER } from '@/lib/cardano/identity';

vi.mock('@/lib/wallet/useCardanoWallets.js', () => ({
  useCardanoWallets: () => ({
    wallets: [
      {
        key: 'w',
        name: 'Test wallet',
        icon: '',
        supportsCip95: true,
        raw: { name: 'Test wallet', icon: '', enable: async () => ({ getNetworkId: async () => 0 }) },
      },
    ],
    selected: 'w',
    setSelected: () => {},
  }),
  rememberWallet: () => {},
}));
vi.mock('@/lib/wallet/networkGuard.js', () => ({ assertWalletNetwork: async () => {} }));

const buildMock = vi.fn(async (_args: unknown) => {
  throw new Error('build reached');
});
vi.mock('@/lib/governance/scriptVoteTx.js', () => ({ buildScriptDRepVoteTx: buildMock }));

import MultisigVotePanel from './MultisigVotePanel.js';

const VALUE = { type: 'any', scripts: [{ type: 'sig', keyHash: 'a'.repeat(56) }] };
const HASH = nativeScriptHash(parseNativeScriptJson(VALUE)!);
const payload = new Uint8Array(29);
payload[0] = DREP_SCRIPT_HEADER;
payload.set(hexToBytes(HASH), 1);
const DREP_ID = encodeBech32('drep', payload);

function stubFetch(scriptRes: Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/drep/multisig/script')) return scriptRes;
      if (url.includes('/api/drep/multisig/list')) return Response.json({ items: [] });
      return new Response('forbidden', { status: 403 });
    }),
  );
  return calls;
}

function renderPanel() {
  render(<MultisigVotePanel gaId={`${'b'.repeat(64)}#0`} network="preprod" scriptDrepId={DREP_ID} mode="initiate" />);
  fireEvent.click(screen.getByRole('button', { name: /^Start vote$/ }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MultisigVotePanel script loading', () => {
  it('requests the server route and never the Koios proxy', async () => {
    const calls = stubFetch(Response.json({ value: VALUE }));
    renderPanel();
    await waitFor(() => expect(buildMock).toHaveBeenCalled());
    expect(calls.some((u) => u.includes('/api/drep/multisig/script'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/koios/script_info'))).toBe(false);
    expect(buildMock.mock.calls[0]?.[0]).toMatchObject({ scriptDrepId: DREP_ID });
  });

  it('shows the load error sentence when the route fails', async () => {
    stubFetch(Response.json({ error: 'script not found' }, { status: 422 }));
    renderPanel();
    await screen.findByText('Could not load the multisig script. Please try again.');
    expect(buildMock).not.toHaveBeenCalled();
  });
});
