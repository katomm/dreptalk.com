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
export const h3 = { fontSize: '1rem', margin: 0 } as const;
export const stack = { display: 'flex', flexDirection: 'column', gap: '0.5rem' } as const;
/** A bordered panel around one step, as the sign-in and form islands frame theirs. */
export const card = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 14px)',
  background: 'var(--bg)',
  padding: '1rem 1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
} as const;
/** One part of the group page's Manage section, the section draws the dividers between its parts. */
export const part = { display: 'flex', flexDirection: 'column', gap: '0.75rem' } as const;
/** A plain list of rows: names with a checkbox, signers, requests. */
export const rows = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.375rem' } as const;
/** A checkbox or radio with its text. */
export const choice = { display: 'inline-flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.9375rem', cursor: 'pointer' } as const;
/** A small heading above a group of fields or rows. */
export const fieldHeading = { margin: 0, fontWeight: 600, fontSize: '0.875rem' } as const;
/** A row of buttons. */
export const buttons = { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } as const;

// The check mark of the site's success callouts, as the vote panels show it.
const SUCCESS_ICON = (
  <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

export function Callout({ kind, title, children }: { kind: 'error' | 'info' | 'success'; title?: string; children: React.ReactNode }) {
  return (
    <div className={`callout callout--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'success' && SUCCESS_ICON}
      <div className="callout__body">
        {title && <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** The fallback sentence and the server's reason as a second sentence, ending in one period. */
export async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  const reason = body?.error?.trim();
  if (!reason) return fallback;
  const sentence = `${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
  return `${fallback} ${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`}`;
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
