// Tests for constitutional committee update validation: cold credential
// parsing (CIP-129 and raw hex) and the UpdateCommittee field rules.
import { describe, expect, it } from 'vitest';
import { encodeBech32 } from '../crypto/bech32.js';
import {
  type ColdCredential,
  parseColdCredential,
  validateCommitteeUpdate,
} from './committeeUpdate.js';

// The script committee member from src/lib/koios/client.test.ts (cc_cold_has_script: true).
const SCRIPT_BECH32 = 'cc_cold1zvcxrfwegfn9ls72cmfchty3cnczwtztc2e48eyxxwnrw3cwfypz8';
const SCRIPT_HEX = '3061a5d942665fc3cac6d38bac91c4f0272c4bc2b353e48633a63747';

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe('parseColdCredential', () => {
  it('accepts 56 lowercase hex chars as a key hash', () => {
    const hex = 'a'.repeat(56);
    expect(parseColdCredential(hex, 'key')).toEqual({ hashHex: hex, isScript: false });
  });

  it('accepts 56 lowercase hex chars as a script hash', () => {
    const hex = 'b'.repeat(56);
    expect(parseColdCredential(hex, 'script')).toEqual({ hashHex: hex, isScript: true });
  });

  it('accepts uppercase hex by lowercasing', () => {
    const hex = 'A'.repeat(56);
    expect(parseColdCredential(hex, 'key')).toEqual({ hashHex: 'a'.repeat(56), isScript: false });
  });

  it('trims whitespace around hex input', () => {
    const hex = 'c'.repeat(56);
    expect(parseColdCredential(`  ${hex}  `, 'key')).toEqual({ hashHex: hex, isScript: false });
  });

  it('rejects hex of the wrong length', () => {
    expect(parseColdCredential('a'.repeat(55), 'key')).toBeNull();
    expect(parseColdCredential('a'.repeat(57), 'key')).toBeNull();
  });

  it('decodes a real CIP-129 cc_cold script credential', () => {
    expect(parseColdCredential(SCRIPT_BECH32, 'key')).toEqual({
      hashHex: SCRIPT_HEX,
      isScript: true,
    });
  });

  it('decodes a CIP-129 cc_cold key credential built from a known header and hash', () => {
    const hashHex = 'd'.repeat(56);
    const payload = new Uint8Array(29);
    payload[0] = 0x12;
    payload.set(bytesFromHex(hashHex), 1);
    const encoded = encodeBech32('cc_cold', payload);
    expect(parseColdCredential(encoded, 'script')).toEqual({ hashHex, isScript: false });
  });

  it('rejects an unknown header byte', () => {
    const payload = new Uint8Array(29);
    payload[0] = 0x99;
    const encoded = encodeBech32('cc_cold', payload);
    expect(parseColdCredential(encoded, 'key')).toBeNull();
  });

  it('rejects a payload of the wrong length', () => {
    const payload = new Uint8Array(28);
    payload[0] = 0x12;
    const encoded = encodeBech32('cc_cold', payload);
    expect(parseColdCredential(encoded, 'key')).toBeNull();
  });

  it('rejects a bad checksum', () => {
    const broken = `${SCRIPT_BECH32.slice(0, -1)}${SCRIPT_BECH32.endsWith('z') ? 'q' : 'z'}`;
    expect(parseColdCredential(broken, 'key')).toBeNull();
  });

  it('rejects the cc_hot prefix', () => {
    const payload = new Uint8Array(29);
    payload[0] = 0x12;
    const encoded = encodeBech32('cc_hot', payload);
    expect(parseColdCredential(encoded, 'key')).toBeNull();
  });

  it('rejects the drep prefix', () => {
    const payload = new Uint8Array(29);
    payload[0] = 0x22;
    const encoded = encodeBech32('drep', payload);
    expect(parseColdCredential(encoded, 'key')).toBeNull();
  });

  it('rejects the gov_action prefix', () => {
    const payload = new Uint8Array(33);
    const encoded = encodeBech32('gov_action', payload);
    expect(parseColdCredential(encoded, 'key')).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(parseColdCredential('not a credential', 'key')).toBeNull();
    expect(parseColdCredential('', 'key')).toBeNull();
  });
});

describe('validateCommitteeUpdate', () => {
  const cred = (n: string, isScript = false): ColdCredential => ({ hashHex: n.repeat(56), isScript });

  const base = {
    epoch: 500,
    maxTermLength: 100,
    current: [] as { hashHex: string; isScript: boolean; expirationEpoch: number | null }[],
    remove: [] as ColdCredential[],
    add: [] as { credential: ColdCredential; expiryEpoch: number }[],
    quorum: { numerator: 2, denominator: 3 },
    currentQuorum: { numerator: 2, denominator: 3 },
  };

  it('errors when an added credential expires at or before the current epoch', () => {
    const result = validateCommitteeUpdate({
      ...base,
      add: [{ credential: cred('a'), expiryEpoch: 500 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        field: 'add[0].expiryEpoch',
        message: expect.any(String),
      });
    }
  });

  it('errors when an added credential expires beyond epoch + maxTermLength', () => {
    const result = validateCommitteeUpdate({
      ...base,
      add: [{ credential: cred('a'), expiryEpoch: 601 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].field).toBe('add[0].expiryEpoch');
      expect(result.errors[0].message).toMatch(/ratify/i);
    }
  });

  it('allows an expiry beyond epoch + maxTermLength when maxTermLength is null', () => {
    const result = validateCommitteeUpdate({
      ...base,
      maxTermLength: null,
      add: [{ credential: cred('a'), expiryEpoch: 100000 }],
    });
    expect(result.ok).toBe(true);
  });

  it('errors when a credential is both added and removed', () => {
    const c = cred('a');
    const result = validateCommitteeUpdate({
      ...base,
      remove: [c],
      add: [{ credential: c, expiryEpoch: 600 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === 'add[0].credential')).toBe(true);
    }
  });

  it('warns when an added credential is already a current member', () => {
    const c = cred('a');
    const result = validateCommitteeUpdate({
      ...base,
      current: [{ hashHex: c.hashHex, isScript: c.isScript, expirationEpoch: 700 }],
      add: [{ credential: c, expiryEpoch: 600 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some(w => w.field === 'add[0].credential')).toBe(true);
    }
  });

  it('errors when the quorum numerator is not a non-negative integer', () => {
    const result = validateCommitteeUpdate({
      ...base,
      quorum: { numerator: -1, denominator: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === 'quorum.numerator')).toBe(true);
    }
  });

  it('errors when the quorum numerator is not an integer', () => {
    const result = validateCommitteeUpdate({
      ...base,
      quorum: { numerator: 1.5, denominator: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === 'quorum.numerator')).toBe(true);
    }
  });

  it('errors when the quorum denominator is not a positive integer', () => {
    const result = validateCommitteeUpdate({
      ...base,
      quorum: { numerator: 1, denominator: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === 'quorum.denominator')).toBe(true);
    }
  });

  it('errors when the quorum numerator exceeds the denominator', () => {
    const result = validateCommitteeUpdate({
      ...base,
      quorum: { numerator: 4, denominator: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === 'quorum.numerator')).toBe(true);
    }
  });

  it('accepts a quorum numerator of 0', () => {
    const result = validateCommitteeUpdate({
      ...base,
      quorum: { numerator: 0, denominator: 3 },
      currentQuorum: { numerator: 2, denominator: 3 },
    });
    expect(result.ok).toBe(true);
  });

  it('errors when quorum is null', () => {
    const result = validateCommitteeUpdate({
      ...base,
      quorum: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === 'quorum.numerator')).toBe(true);
    }
  });

  it('errors on duplicate rows in add', () => {
    const c = cred('a');
    const result = validateCommitteeUpdate({
      ...base,
      add: [
        { credential: c, expiryEpoch: 600 },
        { credential: c, expiryEpoch: 650 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === 'add[1].credential')).toBe(true);
    }
  });

  it('is valid with empty add and remove when the quorum changed', () => {
    const result = validateCommitteeUpdate({
      ...base,
      quorum: { numerator: 1, denominator: 3 },
      currentQuorum: { numerator: 2, denominator: 3 },
    });
    expect(result.ok).toBe(true);
  });

  it('errors on empty add and remove with the current quorum unchanged', () => {
    const result = validateCommitteeUpdate({
      ...base,
      quorum: { numerator: 2, denominator: 3 },
      currentQuorum: { numerator: 2, denominator: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === 'changes')).toBe(true);
    }
  });

  it('is valid when currentQuorum is null (no prior quorum known) and a quorum is given', () => {
    const result = validateCommitteeUpdate({
      ...base,
      currentQuorum: null,
      quorum: { numerator: 2, denominator: 3 },
    });
    expect(result.ok).toBe(true);
  });

  it('returns the built value on success', () => {
    const c = cred('a');
    const result = validateCommitteeUpdate({
      ...base,
      remove: [cred('b')],
      add: [{ credential: c, expiryEpoch: 600 }],
      quorum: { numerator: 1, denominator: 3 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        remove: [cred('b')],
        add: [{ credential: c, expiryEpoch: 600 }],
        quorum: { numerator: 1, denominator: 3 },
      });
    }
  });
});
