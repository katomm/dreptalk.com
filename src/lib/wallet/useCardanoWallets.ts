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
  return typeof obj['enable'] === 'function' && typeof obj['name'] === 'string';
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

/**
 * useCardanoWallets
 *
 * React hook: enumerates available Cardano wallets from window.cardano on
 * mount. Returns the list, the currently selected wallet key, and a setter.
 * Initial selection is the first wallet in the list (same behavior as the
 * former inline useEffect in WalletLogin).
 */
export function useCardanoWallets(): {
  wallets: CardanoWalletInfo[];
  selected: string;
  setSelected: (key: string) => void;
} {
  const [wallets, setWallets] = useState<CardanoWalletInfo[]>([]);
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    const cardano = (window as unknown as { cardano?: unknown }).cardano;
    const found = listCardanoWallets(cardano);
    setWallets(found);
    if (found.length > 0) setSelected(found[0].key);
  }, []);

  return { wallets, selected, setSelected };
}
