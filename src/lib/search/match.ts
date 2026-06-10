// Builds a safe FTS5 MATCH expression from raw user input.
//
// FTS5 has its own query syntax (AND/OR/NOT, parentheses, NEAR, quoted
// phrases); raw input must never reach MATCH or it both breaks on syntax
// errors and lets users run arbitrary query operators. Double quotes are
// stripped, every remaining token is double-quoted (turning operators into
// literals), and the final token gets a * suffix so the palette matches the
// word still being typed. The result is bound as a query parameter.

const MAX_TOKENS = 8;

/** Returns the MATCH string, or null when the input has no searchable token. */
export function buildMatch(raw: string): string | null {
  const tokens = raw
    .replace(/"/g, ' ')
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, MAX_TOKENS);
  if (tokens.length === 0) return null;
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ');
}
