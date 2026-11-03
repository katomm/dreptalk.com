// Light parts every DRep group island shares: the callout, the styles, the JSON post with its error
// text and the connection of the wallet that signs or pays. Kept apart from the action flow so the
// signing page and the shell of the group page do not load the group library.
import { useCallback, useRef } from 'react';
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { WalletApi } from '@/lib/governance/walletUtxos.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { rememberWallet, useCardanoWallets } from '@/lib/wallet/useCardanoWallets.js';
import { readableError } from '@/lib/wallet/walletError.js';

export type EnabledWalletApi = WalletApi & { getNetworkId(): Promise<number> };

export const muted = { color: 'var(--muted)', fontSize: '0.875rem', margin: 0 } as const;
export const h2 = { fontSize: '1.0625rem', margin: '0 0 0.5rem' } as const;
export const stack = { display: 'flex', flexDirection: 'column', gap: '0.5rem' } as const;

export function Callout({ kind, children }: { kind: 'error' | 'info' | 'success'; children: React.ReactNode }) {
  return (
    <div className={`callout callout--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="callout__body">{children}</div>
    </div>
  );
}

export async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ? `${fallback} ${body.error}.` : fallback;
}

export const post = (url: string, body?: unknown) =>
  fetchWithTimeout(url, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

/** The selectable wallets and the connection of the selected one, enabled once and kept. */
export function useWalletConnect(network: CardanoNetwork, setError: (e: string | null) => void) {
  const { wallets, selected: walletKey, setSelected: setWalletKey } = useCardanoWallets({ preferCip95: true });
  const apiRef = useRef<EnabledWalletApi | null>(null);

  const connect = useCallback(async (): Promise<EnabledWalletApi | null> => {
    if (apiRef.current) return apiRef.current;
    const info = wallets.find((w) => w.key === walletKey);
    if (!info) {
      setError('Select a wallet to continue.');
      return null;
    }
    try {
      const api = (await info.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;
      await assertWalletNetwork(api, network);
      apiRef.current = api;
      rememberWallet(walletKey);
      return api;
    } catch (err) {
      setError(readableError(err));
      return null;
    }
  }, [wallets, walletKey, network, setError]);

  return { wallets, walletKey, setWalletKey, connect };
}
