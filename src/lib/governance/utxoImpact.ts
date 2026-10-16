// The minimum ada of typical outputs at a given UTxO cost per byte, for the
// parameter card's chart. Babbage and later: (160 + serialized output bytes)
// times the cost per byte. Byte counts are the serialized sizes of the
// fixtures in utxoImpact.test.ts, in the encoding wallets size an output
// with (map form, coin at its full 9 bytes), so the figures match what a
// wallet's send screen asks for. Pure, no I/O.

export interface ExampleOutput {
  id: 'plain' | 'token' | 'tokens10' | 'datum';
  label: string;
  bytes: number;
}

export const UTXO_OVERHEAD_BYTES = 160;

export const EXAMPLE_OUTPUTS: readonly ExampleOutput[] = [
  { id: 'plain', label: 'Plain ada', bytes: 71 },
  { id: 'token', label: 'With 1 token', bytes: 116 },
  { id: 'datum', label: 'Inline datum', bytes: 121 },
  { id: 'tokens10', label: '10 tokens, 1 policy', bytes: 224 },
];

export const REFERENCE_SCRIPT_OUTPUT = { label: '10 KB reference script', bytes: 10_322 };

export function minAdaLovelace(bytes: number, rate: bigint): bigint {
  return BigInt(UTXO_OVERHEAD_BYTES + bytes) * rate;
}

/** The largest bar at the top of the guardrail range, for a scale that does not move while typing. */
export function barScaleMaxLovelace(maxRate: bigint): bigint {
  return minAdaLovelace(Math.max(...EXAMPLE_OUTPUTS.map((o) => o.bytes)), maxRate);
}
