import { describe, it, expect } from 'vitest';
import { listCardanoWallets, chooseSelectedWallet } from './useCardanoWallets.js';

// Minimal stub that matches the CIP-30 shape expected by listCardanoWallets.
const fakeCardano = {
  lace: {
    name: 'Lace',
    icon: 'data:image/png;base64,lace',
    enable: async () => ({}),
    // CIP-95 is advertised: supportsCip95 must be true.
    supportedExtensions: [{ cip: 95 }],
  },
  eternl: {
    name: 'Eternl',
    icon: 'data:image/png;base64,eternl',
    enable: async () => ({}),
    // No CIP-95 extension: supportsCip95 must be false.
    supportedExtensions: [{ cip: 30 }],
  },
  noExt: {
    name: 'NoExt',
    icon: '',
    enable: async () => ({}),
    // supportedExtensions absent: supportsCip95 must be false.
  },
  // junk: missing enable function, must be skipped.
  junk: {
    name: 'Junk',
    icon: '',
  },
  // null entry: must be skipped.
  nullEntry: null,
  // number entry: must be skipped.
  numEntry: 42,
};

describe('listCardanoWallets', () => {
  it('returns only entries with a name string and an enable function', () => {
    const result = listCardanoWallets(fakeCardano);
    const keys = result.map((w) => w.key);
    expect(keys).toContain('lace');
    expect(keys).toContain('eternl');
    expect(keys).toContain('noExt');
    // junk and nullEntry and numEntry must not appear.
    expect(keys).not.toContain('junk');
    expect(keys).not.toContain('nullEntry');
    expect(keys).not.toContain('numEntry');
  });

  it('maps name and icon correctly', () => {
    const result = listCardanoWallets(fakeCardano);
    const lace = result.find((w) => w.key === 'lace')!;
    expect(lace.name).toBe('Lace');
    expect(lace.icon).toBe('data:image/png;base64,lace');

    const eternl = result.find((w) => w.key === 'eternl')!;
    expect(eternl.name).toBe('Eternl');
    expect(eternl.icon).toBe('data:image/png;base64,eternl');
  });

  it('sets supportsCip95 true only for wallets advertising CIP-95', () => {
    const result = listCardanoWallets(fakeCardano);
    const lace = result.find((w) => w.key === 'lace')!;
    const eternl = result.find((w) => w.key === 'eternl')!;
    const noExt = result.find((w) => w.key === 'noExt')!;

    expect(lace.supportsCip95).toBe(true);
    expect(eternl.supportsCip95).toBe(false);
    expect(noExt.supportsCip95).toBe(false);
  });

  it('falls back to empty string when icon is absent', () => {
    const result = listCardanoWallets(fakeCardano);
    const noExt = result.find((w) => w.key === 'noExt')!;
    expect(noExt.icon).toBe('');
  });

  it('returns an empty array for null input', () => {
    expect(listCardanoWallets(null)).toEqual([]);
  });

  it('returns an empty array for a non-object input', () => {
    expect(listCardanoWallets('not-an-object')).toEqual([]);
    expect(listCardanoWallets(undefined)).toEqual([]);
  });

  it('attaches the raw wallet object', () => {
    const result = listCardanoWallets(fakeCardano);
    const lace = result.find((w) => w.key === 'lace')!;
    expect(lace.raw).toBe(fakeCardano.lace);
  });
});

describe('chooseSelectedWallet', () => {
  const found = (...keys: string[]) => keys.map((key) => ({ key }) as { key: string });

  it('keeps the current pick when it is still available', () => {
    expect(chooseSelectedWallet('eternl', 'lace', found('lace', 'eternl'))).toBe('eternl');
  });

  it('prefers the remembered wallet over the first one when nothing is picked', () => {
    expect(chooseSelectedWallet('', 'eternl', found('lace', 'eternl'))).toBe('eternl');
  });

  it('falls back to the first wallet when the remembered one is gone', () => {
    expect(chooseSelectedWallet('', 'typhon', found('lace', 'eternl'))).toBe('lace');
  });

  it('falls back to the first wallet when nothing is remembered', () => {
    expect(chooseSelectedWallet('', null, found('lace', 'eternl'))).toBe('lace');
  });

  it('returns empty when no wallets are found', () => {
    expect(chooseSelectedWallet('', 'lace', [])).toBe('');
  });
});
