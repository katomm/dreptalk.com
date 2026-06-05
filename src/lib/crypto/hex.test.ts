// Tests for hex utility helpers.
import { describe, it, expect } from 'vitest';
import { hexToBytes, bytesToHex } from './hex.js';

describe('hexToBytes', () => {
  it('converts a known hex string to bytes', () => {
    const result = hexToBytes('deadbeef');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('handles an empty string', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('handles uppercase hex', () => {
    expect(Array.from(hexToBytes('DEADBEEF'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('throws on odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow('hex string must have even length');
  });

  it('throws on non-hex characters', () => {
    expect(() => hexToBytes('deadbeXX')).toThrow('invalid hex string');
  });
});

describe('bytesToHex', () => {
  it('converts bytes to a lowercase hex string', () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  it('handles an empty array', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });

  it('round-trips with hexToBytes', () => {
    const original = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(bytesToHex(hexToBytes(original))).toBe(original);
  });
});
