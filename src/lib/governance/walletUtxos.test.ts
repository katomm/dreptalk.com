// Unit tests for the input selection shared by every client-side tx builder.
// collectWalletUtxos needs a live wallet and Koios, so only the pure selection
// is covered here. It is the part that decides whether a funded wallet can pay
// for a certificate or vote tx at all, and it was duplicated across two builders
// without a direct test of its own.
import { describe, it, expect } from 'vitest';
import type { UTxO } from '@evolution-sdk/evolution';
import { TransactionHash } from '@evolution-sdk/evolution';
import { dedupeByOutRef, pickInputsToCover, utxoLovelace } from './walletUtxos.js';

// Selection reads nothing but `assets`, so the fixtures carry that plus a label
// to assert on. Building real SDK UTxOs would need a full codec and would not
// exercise anything more.
const utxo = (id: string, lovelace: bigint | undefined): UTxO.UTxO =>
  ({ id, assets: lovelace === undefined ? {} : { lovelace } }) as unknown as UTxO.UTxO;

const ids = (utxos: UTxO.UTxO[]) => utxos.map((u) => (u as unknown as { id: string }).id);
const total = (utxos: UTxO.UTxO[]) => utxos.reduce((sum, u) => sum + utxoLovelace(u), 0n);

describe('utxoLovelace', () => {
  it('reads a missing lovelace entry as zero rather than throwing', () => {
    expect(utxoLovelace(utxo('aa', undefined))).toBe(0n);
  });
});

describe('pickInputsToCover', () => {
  it('returns nothing for an empty wallet', () => {
    expect(pickInputsToCover([], 5_000_000n)).toEqual([]);
  });

  it('takes the largest UTxO first and stops as soon as the need is covered', () => {
    const utxos = [utxo('a', 1_000_000n), utxo('b', 9_000_000n), utxo('c', 4_000_000n)];
    const picked = pickInputsToCover(utxos, 5_000_000n);
    expect(ids(picked)).toEqual(['b']);
  });

  it('adds further inputs, still largest first, until the need is covered', () => {
    const utxos = [utxo('a', 1_000_000n), utxo('b', 9_000_000n), utxo('c', 4_000_000n)];
    const picked = pickInputsToCover(utxos, 12_000_000n);
    expect(ids(picked)).toEqual(['b', 'c']);
  });

  it('stops at an exact match without pulling in another input', () => {
    const utxos = [utxo('a', 3_000_000n), utxo('b', 2_000_000n), utxo('c', 7_000_000n)];
    const picked = pickInputsToCover(utxos, 10_000_000n);
    expect(total(picked)).toBe(10_000_000n);
    expect(picked).toHaveLength(2);
  });

  // An underfunded wallet gets everything, so the builder fails with the SDK's
  // own balance error naming the real shortfall, not a selection error hiding it.
  it('returns every UTxO when the wallet cannot reach the target', () => {
    const utxos = [utxo('a', 1_000_000n), utxo('b', 2_000_000n)];
    const picked = pickInputsToCover(utxos, 500_000_000n);
    expect(picked).toHaveLength(2);
    expect(total(picked)).toBe(3_000_000n);
  });

  // The DRep registration deposit plus headroom, the largest amount any caller asks for.
  it('covers a deposit plus headroom from many equal UTxOs, taking only as many as needed', () => {
    const utxos = Array.from({ length: 40 }, (_, i) => utxo(`u${i}`, 20_000_000n));
    const picked = pickInputsToCover(utxos, 505_000_000n);
    expect(picked).toHaveLength(26);
    expect(total(picked)).toBeGreaterThanOrEqual(505_000_000n);
  });

  it('does not mutate or reorder the caller-s array', () => {
    const utxos = [utxo('a', 1_000_000n), utxo('b', 9_000_000n)];
    pickInputsToCover(utxos, 5_000_000n);
    expect(ids(utxos)).toEqual(['a', 'b']);
  });

  it('treats a zero-lovelace UTxO as contributing nothing', () => {
    const utxos = [utxo('a', undefined), utxo('b', 6_000_000n)];
    const picked = pickInputsToCover(utxos, 5_000_000n);
    expect(ids(picked)).toEqual(['b']);
  });
});

// A UTxO carrying a real output reference, which is what the dedupe keys on.
const ref = (txHash: string, index: bigint) =>
  ({ transactionId: TransactionHash.fromHex(txHash.repeat(32)), index }) as unknown as UTxO.UTxO;

describe('dedupeByOutRef', () => {
  it('collapses the same output reported twice', () => {
    expect(dedupeByOutRef([ref('ab', 0n), ref('ab', 0n)])).toHaveLength(1);
  });

  it('keeps separate outputs of one transaction apart', () => {
    expect(dedupeByOutRef([ref('ab', 0n), ref('ab', 1n)])).toHaveLength(2);
  });

  it('keeps outputs of different transactions apart', () => {
    expect(dedupeByOutRef([ref('ab', 0n), ref('cd', 0n)])).toHaveLength(2);
  });

  it('passes an empty list through', () => {
    expect(dedupeByOutRef([])).toEqual([]);
  });
});
