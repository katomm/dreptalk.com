import { describe, it, expect, beforeEach } from 'vitest';
import { nextDelay, loadPairing, savePairing, clearPairing, type StoredPairing } from './PairWithDesktop.js';

// The node test project has no DOM, so `localStorage` does not exist. Stub a
// minimal in-memory implementation good enough for these helpers.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

const PAIRING_KEY = 'dreptalk_pairing';

function futureExpiry(): number {
  return Math.floor(Date.now() / 1000) + 600;
}

function pastExpiry(): number {
  return Math.floor(Date.now() / 1000) - 60;
}

describe('nextDelay', () => {
  it('widens from the first delay towards the ceiling', () => {
    const first = 2000;
    const second = nextDelay(first);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(5000);
  });

  it('stays at the ceiling once reached', () => {
    let delay = 2000;
    for (let i = 0; i < 20; i++) delay = nextDelay(delay);
    expect(delay).toBe(5000);
    expect(nextDelay(delay)).toBe(5000);
  });
});

describe('loadPairing', () => {
  it('returns null when nothing is stored', () => {
    expect(loadPairing()).toBeNull();
  });

  it('returns null and clears the stored value when the pairing has expired', () => {
    const stored: StoredPairing = { pairingId: 'p1', deviceSecret: 's1', expiresAt: pastExpiry() };
    localStorage.setItem(PAIRING_KEY, JSON.stringify(stored));
    expect(loadPairing()).toBeNull();
    expect(localStorage.getItem(PAIRING_KEY)).toBeNull();
  });

  it('returns the stored pairing when it is still valid', () => {
    const stored: StoredPairing = { pairingId: 'p1', deviceSecret: 's1', expiresAt: futureExpiry() };
    localStorage.setItem(PAIRING_KEY, JSON.stringify(stored));
    expect(loadPairing()).toEqual(stored);
  });

  it('returns null and clears the key when the stored value is malformed JSON', () => {
    localStorage.setItem(PAIRING_KEY, '{not json');
    expect(loadPairing()).toBeNull();
    expect(localStorage.getItem(PAIRING_KEY)).toBeNull();
  });
});

describe('savePairing / clearPairing', () => {
  it('round-trips through loadPairing without ever persisting a pairing code', () => {
    const stored: StoredPairing = { pairingId: 'p1', deviceSecret: 's1', expiresAt: futureExpiry() };
    savePairing(stored);
    expect(loadPairing()).toEqual(stored);

    const raw = localStorage.getItem(PAIRING_KEY);
    expect(raw).not.toBeNull();
    // The pairing code must never be persisted, only the pairingId and
    // deviceSecret needed to resume polling.
    expect(raw).not.toContain('code');
  });

  it('clearPairing removes the key', () => {
    const stored: StoredPairing = { pairingId: 'p1', deviceSecret: 's1', expiresAt: futureExpiry() };
    savePairing(stored);
    expect(localStorage.getItem(PAIRING_KEY)).not.toBeNull();
    clearPairing();
    expect(localStorage.getItem(PAIRING_KEY)).toBeNull();
  });
});
