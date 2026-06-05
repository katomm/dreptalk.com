// Tests for bech32 encode/decode wrappers.
import { describe, it, expect } from 'vitest';
import { encodeBech32, decodeBech32 } from './bech32.js';
import { hexToBytes } from './hex.js';

const FIXTURE_STAKE_ADDR = 'stake_test1uqpqhw7q2jcutnwteqnvdgqkjulnaa5ym8wh70kcu3yvkugckkcgj';
// Raw bytes for the fixture address (29 bytes: 1 header + 28 hash).
const FIXTURE_ADDR_HEX = 'e0020bbbc054b1c5cdcbc826c6a016973f3ef684d9dd7f3ed8e448cb71';

describe('encodeBech32 / decodeBech32', () => {
  it('round-trips arbitrary bytes', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0xab, 0xcd, 0xef]);
    const encoded = encodeBech32('test', data);
    const { prefix, data: decoded } = decodeBech32(encoded);
    expect(prefix).toBe('test');
    expect(Array.from(decoded)).toEqual(Array.from(data));
  });

  it('decodes the fixture stake address to the expected raw bytes', () => {
    const { prefix, data } = decodeBech32(FIXTURE_STAKE_ADDR);
    expect(prefix).toBe('stake_test');
    expect(Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('')).toBe(FIXTURE_ADDR_HEX);
  });

  it('re-encodes the fixture stake address back to the same string', () => {
    const rawBytes = hexToBytes(FIXTURE_ADDR_HEX);
    const encoded = encodeBech32('stake_test', rawBytes);
    expect(encoded).toBe(FIXTURE_STAKE_ADDR);
  });

  it('handles long Cardano strings beyond the default 90-char limit', () => {
    // A 64-byte payload encodes to >90 chars. This should not throw.
    const data = new Uint8Array(64).fill(0xaa);
    expect(() => encodeBech32('addr', data)).not.toThrow();
    const encoded = encodeBech32('addr', data);
    expect(encoded.length).toBeGreaterThan(90);
    const { data: decoded } = decodeBech32(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(data));
  });
});
