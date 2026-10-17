// Koios v1.5 sends lovelace as JSON numbers, and JSON.parse rounds an integer
// above 2^53 (circulation, supply, aggregated stake). Needs the reviver's
// source text (JSON.parse source text access), available in workerd and
// Node 21+.

interface ReviverContext {
  readonly source?: string;
}

const INTEGER_SOURCE = /^-?\d+$/;

function exactReviver(_key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== 'number' || !Number.isInteger(value) || Number.isSafeInteger(value)) {
    return value;
  }
  const source = context?.source;
  if (source === undefined || !INTEGER_SOURCE.test(source)) {
    throw new Error(`Koios JSON: ${source ?? value} cannot be read exactly`);
  }
  return source;
}

/**
 * Parse a Koios response body. Strings, decimals and safe integers come back
 * as JSON.parse returns them. An integer above 2^53 comes back as its exact
 * decimal string, the form every lovelace schema and BigInt() caller expects.
 * A number that is only an integer after rounding (1e20,
 * 9.007199254740993e15) throws, since its exact value cannot be recovered.
 */
export function parseKoiosJson(text: string): unknown {
  return JSON.parse(text, exactReviver as (key: string, value: unknown) => unknown);
}
