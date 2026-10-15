// Sizes of the example outputs in the minimum ada chart. Each fixture is a
// legal output the SDK decodes and re-encodes to the same bytes, so the
// table's byte counts are serialized sizes, not estimates.
import { describe, it, expect } from 'vitest';
import { TransactionOutput } from '@evolution-sdk/evolution';
import { EXAMPLE_OUTPUTS, REFERENCE_SCRIPT_OUTPUT, barScaleMaxLovelace, minAdaLovelace } from './utxoImpact.js';

const hex = (n: number, width: number) => n.toString(16).padStart(width * 2, '0');
const uint = (n: number) => (n < 24 ? hex(n, 1) : n < 0x100 ? `18${hex(n, 1)}` : n < 0x10000 ? `19${hex(n, 2)}` : `1a${hex(n, 4)}`);
const bytes = (b: string) => {
  const len = b.length / 2;
  const head = len < 24 ? hex(0x40 + len, 1) : len < 0x100 ? `58${hex(len, 1)}` : `59${hex(len, 2)}`;
  return head + b;
};
const arr = (...items: string[]) => hex(0x80 + items.length, 1) + items.join('');
const map = (pairs: [string, string][]) => hex(0xa0 + pairs.length, 1) + pairs.map(([k, v]) => k + v).join('');
const tag24 = (inner: string) => `d818${bytes(inner)}`;

// Testnet base address, key payment and key stake credential: header 0x00 plus two 28-byte hashes.
const ADDRESS = bytes(`00${'11'.repeat(28)}${'22'.repeat(28)}`);
const COIN = uint(2_000_000);
const POLICY = bytes('33'.repeat(28));
const name = (i: number) => bytes(`${hex(i, 1)}${'44'.repeat(9)}`);
// A typical lock datum, Constr 0 [owner key hash, deadline in ms]: tag 121, an
// indefinite list as Plutus encodes it, a 28-byte bytestring (within the
// 64-byte limit for definite bytestrings in Plutus data) and an 8-byte uint.
const DATUM = `d8799f${bytes('77'.repeat(28))}1b${hex(1_700_000_000_000, 8)}ff`;
const tokens = (count: number) => arr(COIN, map([[POLICY, map(Array.from({ length: count }, (_, i) => [name(i), uint(1)] as [string, string]))]]));

const FIXTURES: Record<string, string> = {
  plain: arr(ADDRESS, COIN),
  token: arr(ADDRESS, tokens(1)),
  tokens10: arr(ADDRESS, tokens(10)),
  datum: map([[uint(0), ADDRESS], [uint(1), COIN], [uint(2), arr(uint(1), tag24(DATUM))]]),
};
// A PlutusV3 reference script (script language tag 3) of exactly 10,240 bytes.
const SCRIPT = map([[uint(0), ADDRESS], [uint(1), COIN], [uint(3), tag24(arr(uint(3), bytes('66'.repeat(10_240))))]]);

const sizeOf = (cbor: string) => {
  const decoded = TransactionOutput.fromCBORHex(cbor);
  expect(TransactionOutput.toCBORHex(decoded)).toBe(cbor);
  return cbor.length / 2;
};

describe('example outputs', () => {
  it('match the serialized size of a legal output', () => {
    for (const out of EXAMPLE_OUTPUTS) expect([out.id, out.bytes]).toEqual([out.id, sizeOf(FIXTURES[out.id])]);
    expect(REFERENCE_SCRIPT_OUTPUT.bytes).toBe(sizeOf(SCRIPT));
  });
  it('uses a datum that is legal Plutus data', () => {
    // Constr 0 (tag 121), indefinite list, one 28-byte bytestring (the only
    // bytestring, under the 64-byte limit) and a canonical 8-byte uint.
    expect(DATUM).toBe(`d8799f581c${'77'.repeat(28)}1b0000018bcfe56800ff`);
    expect(DATUM.length / 2).toBe(43);
  });
  it('gives the well-known minimum for a plain ada output', () => {
    const plain = EXAMPLE_OUTPUTS.find((o) => o.id === 'plain')!;
    expect(plain.bytes).toBe(65);
    expect(minAdaLovelace(plain.bytes, 4310n)).toBe(969_750n);
  });
  it('scales the bars to the largest bar output at the top of the range', () => {
    const largest = Math.max(...EXAMPLE_OUTPUTS.map((o) => o.bytes));
    expect(barScaleMaxLovelace(6500n)).toBe(minAdaLovelace(largest, 6500n));
  });
});
