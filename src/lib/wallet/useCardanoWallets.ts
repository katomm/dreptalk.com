// Shared Cardano wallet enumeration logic (CIP-30 + CIP-95 detection).
// Pure function + React hook so both WalletLogin and DRepService can reuse.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WalletApi } from '@/lib/auth/walletLogin.js';

// CIP-30 wallet object shape with optional CIP-95 extension marker.
export interface CardanoWalletInfo {
  key: string;
  name: string;
  icon: string;
  supportsCip95: boolean;
  // The raw window.cardano[key] object for enable().
  raw: {
    enable(opts?: { extensions?: Array<{ cip: number }> }): Promise<WalletApi>;
    name: string;
    icon: string;
    supportedExtensions?: Array<{ cip: number }>;
  };
}

// Internal type guard: a raw wallet entry must have a string name and an
// enable function to be considered valid CIP-30.
function isValidWalletEntry(v: unknown): v is CardanoWalletInfo['raw'] {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.enable === 'function' && typeof obj.name === 'string';
}

/**
 * listCardanoWallets
 *
 * Pure function: takes a window.cardano-like object (or any unknown value) and
 * returns the list of valid CIP-30 wallet entries, mapped to CardanoWalletInfo.
 * Invalid/null/missing entries are silently skipped.
 */
export function listCardanoWallets(cardano: unknown): CardanoWalletInfo[] {
  if (!cardano || typeof cardano !== 'object') return [];

  return Object.entries(cardano as Record<string, unknown>)
    .filter(([, w]) => isValidWalletEntry(w))
    .map(([key, w]) => {
      const raw = w as CardanoWalletInfo['raw'];
      return {
        key,
        name: raw.name,
        icon: raw.icon ?? '',
        supportsCip95: Array.isArray(raw.supportedExtensions)
          ? raw.supportedExtensions.some(e => e.cip === 95)
          : false,
        raw,
      };
    });
}

// localStorage key remembering the wallet last used successfully (login or a
// DRep action). With several extensions installed, defaulting to the first
// injected wallet routinely picks the wrong one; preferring the remembered key
// keeps login, registration, and settings on the wallet the user actually uses.
const LAST_WALLET_STORAGE_KEY = 'dreptalk.lastWallet';

/** Persists the wallet key after a successful use. Safe without localStorage. */
export function rememberWallet(key: string): void {
  try {
    localStorage.setItem(LAST_WALLET_STORAGE_KEY, key);
  } catch {
    // Storage unavailable (private mode, blocked); the default stays first-found.
  }
}

/** Safe without localStorage. */
export function recallWallet(): string | null {
  try {
    return localStorage.getItem(LAST_WALLET_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Picks the selection for a freshly scanned wallet list: a deliberate pick by
 * the user when still present, else the remembered last-used wallet, else the
 * current auto-filled selection, else the first one found.
 *
 * `currentIsUserPick` is what keeps the remembered wallet from being lost to a
 * race. Extensions inject at different times, so an early scan can see only one
 * of two installed wallets. The selection derived from that partial list is
 * provisional and must yield as soon as the remembered wallet appears; without
 * the distinction it would win every later scan simply for being set first, and
 * whichever extension injected fastest would always take over. A selection the
 * user actually clicked is never overruled. Pure; exported for unit tests.
 *
 * `preferCip95` narrows the automatic candidates to wallets advertising CIP-95
 * on the flows that require it (registering, voting, editing a DRep). Without
 * it those flows default to whatever injected first, which in Brave is the
 * browser's own Cardano provider: it cannot do CIP-95, it is not an extension
 * so it always wins the race, and the compact wallet card then hides the real
 * wallet behind "Change wallet", which reads as the wallet not being detected
 * at all. Narrowing the pool (rather than only re-ordering the fallback) is
 * what also frees a provisional or remembered dead-end selection, since both
 * are matched against the pool. When no wallet advertises CIP-95 the pool stays
 * the full list, so the connect step still explains the missing support instead
 * of the page silently offering nothing.
 */
export function chooseSelectedWallet(
  current: string,
  remembered: string | null,
  found: ReadonlyArray<{ key: string; supportsCip95?: boolean }>,
  currentIsUserPick: boolean,
  preferCip95 = false,
): string {
  if (currentIsUserPick && current && found.some(w => w.key === current)) return current;

  const pool =
    preferCip95 && found.some(w => w.supportsCip95) ? found.filter(w => w.supportsCip95) : found;
  const inPool = (key: string) => pool.some(w => w.key === key);

  if (remembered && inPool(remembered)) return remembered;
  if (current && inPool(current)) return current;
  return pool[0]?.key ?? '';
}

/**
 * useCardanoWallets
 *
 * React hook: enumerates available Cardano wallets from window.cardano. Wallet
 * extensions inject window.cardano asynchronously, often AFTER React mounts, so a
 * single check on mount frequently finds nothing. This re-scans on a short
 * interval (and on window load) until wallets appear, then keeps the list current
 * within a brief window. Returns the list, the selected key, a setter (calling it
 * marks the selection as the user's own, so later scans leave it alone), and
 * `scanning`, which stays true until a wallet is found or the scan window closes.
 * Callers that must not act on "no wallet" too early (an empty list is the normal
 * state for the first few hundred milliseconds) should wait for `scanning` to
 * turn false.
 *
 * Flows that need the CIP-95 extension (registering, voting, editing or retiring
 * a DRep) pass `preferCip95` so the default selection skips wallets that cannot
 * do it. See chooseSelectedWallet for why the first-found default is wrong there.
 */
export function useCardanoWallets(opts?: { preferCip95?: boolean }): {
  wallets: CardanoWalletInfo[];
  selected: string;
  setSelected: (key: string) => void;
  scanning: boolean;
} {
  const preferCip95 = opts?.preferCip95 ?? false;
  const [wallets, setWallets] = useState<CardanoWalletInfo[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [scanning, setScanning] = useState(true);
  // Set once the user picks a wallet themselves, which freezes the selection
  // against later scans. A ref, not state: the scan loop only reads it.
  const userPickedRef = useRef(false);

  const setSelectedByUser = useCallback((key: string) => {
    userPickedRef.current = true;
    setSelected(key);
  }, []);

  useEffect(() => {
    // Read once per mount: the remembered wallet is set on a successful action
    // (which navigates away), so it does not change while this hook re-scans.
    const remembered = recallWallet();
    const scan = () => {
      const found = listCardanoWallets((window as unknown as { cardano?: unknown }).cardano);
      setWallets(found);
      // Keep a valid selection: the user's pick, else the remembered wallet,
      // else the first one found.
      setSelected(cur =>
        chooseSelectedWallet(cur, remembered, found, userPickedRef.current, preferCip95),
      );
      // The question "is there a wallet here" is answered as soon as one shows
      // up; later scans only keep the list current.
      if (found.length > 0) setScanning(false);
      return found.length;
    };

    scan();
    // Re-scan every 300ms for ~6s to catch extensions that inject late (and more
    // than one that injects at different times); cheap and bounded.
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      scan();
      if (tries >= 20) {
        clearInterval(interval);
        // Window closed: an empty list now means there really is no wallet.
        setScanning(false);
      }
    }, 300);
    // Some extensions only finish injecting at window 'load'.
    const onLoad = () => scan();
    window.addEventListener('load', onLoad);

    return () => {
      clearInterval(interval);
      window.removeEventListener('load', onLoad);
    };
    // preferCip95 is a constant per flow, listed so the scan can never close
    // over a stale value.
  }, [preferCip95]);

  return { wallets, selected, setSelected: setSelectedByUser, scanning };
}
