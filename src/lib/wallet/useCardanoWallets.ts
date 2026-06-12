// Shared Cardano wallet enumeration logic (CIP-30 + CIP-95 detection).
// Pure function + React hook so both WalletLogin and DRepService can reuse.
import { useState, useEffect } from 'react';
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
function isValidWalletEntry(
  v: unknown,
): v is CardanoWalletInfo['raw'] {
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
          ? raw.supportedExtensions.some((e) => e.cip === 95)
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

function recallWallet(): string | null {
  try {
    return localStorage.getItem(LAST_WALLET_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Picks the selection for a freshly scanned wallet list: the user's current
 * pick when still present, else the remembered last-used wallet, else the
 * first one found. Pure; exported for unit tests.
 */
export function chooseSelectedWallet(
  current: string,
  remembered: string | null,
  found: ReadonlyArray<{ key: string }>,
): string {
  if (current && found.some((w) => w.key === current)) return current;
  if (remembered && found.some((w) => w.key === remembered)) return remembered;
  return found[0]?.key ?? '';
}

/**
 * useCardanoWallets
 *
 * React hook: enumerates available Cardano wallets from window.cardano. Wallet
 * extensions inject window.cardano asynchronously, often AFTER React mounts, so a
 * single check on mount frequently finds nothing. This re-scans on a short
 * interval (and on window load) until wallets appear, then keeps the list current
 * within a brief window. Returns the list, the selected key, and a setter.
 */
export function useCardanoWallets(): {
  wallets: CardanoWalletInfo[];
  selected: string;
  setSelected: (key: string) => void;
} {
  const [wallets, setWallets] = useState<CardanoWalletInfo[]>([]);
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    const scan = () => {
      const found = listCardanoWallets((window as unknown as { cardano?: unknown }).cardano);
      setWallets(found);
      // Keep a valid selection: the user's pick, else the remembered wallet,
      // else the first one found.
      setSelected((cur) => chooseSelectedWallet(cur, recallWallet(), found));
      return found.length;
    };

    scan();
    // Re-scan every 300ms for ~6s to catch extensions that inject late (and more
    // than one that injects at different times); cheap and bounded.
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      scan();
      if (tries >= 20) clearInterval(interval);
    }, 300);
    // Some extensions only finish injecting at window 'load'.
    const onLoad = () => scan();
    window.addEventListener('load', onLoad);

    return () => {
      clearInterval(interval);
      window.removeEventListener('load', onLoad);
    };
  }, []);

  return { wallets, selected, setSelected };
}
