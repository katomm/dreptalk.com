// Tests for the blake2b-224 helper.
import { describe, it, expect } from 'vitest';
import { blake2b224 } from './blake.js';
import { bytesToHex } from './hex.js';

describe('blake2b224', () => {
  it('returns a Uint8Array of exactly 28 bytes', () => {
    const result = blake2b224(new Uint8Array(32));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(28);
  });

  it('produces a stable hash for the 32-byte all-zero key', () => {
    // Reference: blake2b-224 of 32 zero bytes, verified via blakejs.
    const result = blake2b224(new Uint8Array(32));
    expect(Array.from(result).map(b => b.toString(16).padStart(2, '0')).join(''))
      .toBe('f9dca21a6c826ec8acb4cf395cbc24351937bfe6560b2683ab8b415f');
  });

  it('produces different hashes for different inputs', () => {
    const a = blake2b224(new Uint8Array(32));
    const b = blake2b224(new Uint8Array(32).fill(1));
    expect(a).not.toEqual(b);
  });

  it('matches the known external blake2b-224 vector for empty input', () => {
    // External reference vector: blake2b-224("") from the BLAKE2 test suite.
    expect(bytesToHex(blake2b224(new Uint8Array(0))))
      .toBe('836cc68931c2e4e3e838602eca1902591d216837bafddfe6f0c8cb07');
  });
});
