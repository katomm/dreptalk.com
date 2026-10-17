// Koios JSON with every integer exact. JSON.parse rounds an integer above 2^53
// to the nearest double, and Koios serves such integers once v1.5 sends
// lovelace amounts as JSON numbers instead of decimal strings (circulation,
// supply, aggregated stake). The reviver reads such a value from its source
// text and hands it on as the exact decimal string, which is the form every
// lovelace schema, D1 column and BigInt() caller here already expects.
//
// Needs the reviver's source text (JSON.parse source text access), available
// in workerd and Node 21+. Where it is missing, only an integer above 2^53
// fails, and it fails rather than come back rounded.

interface ReviverContext {
  readonly source?: string;
}

const INTEGER_SOURCE = /^-?\d+$/;

/**
 * Parse a Koios response body. Strings, decimals and safe integers come back
 * as JSON.parse returns them. An integer above 2^53 comes back as its exact
 * decimal string. A number that is only an integer after rounding (1e20,
 * 9.007199254740993e15) throws, since its exact value cannot be recovered.
 */
export function parseKoiosJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: ReviverContext): unknown => {
    if (typeof value !== 'number' || !Number.isInteger(value) || Number.isSafeInteger(value)) {
      return value;
    }
    const source = context?.source;
    if (source === undefined || !INTEGER_SOURCE.test(source)) {
      throw new Error(`Koios JSON: ${source ?? value} cannot be read exactly`);
    }
    return source;
  });
}
