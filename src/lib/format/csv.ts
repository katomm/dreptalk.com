// Shared CSV field escaping (RFC 4180), used by every CSV export route so the
// quoting rules cannot drift between them.

/** Wrap a CSV field in double quotes if it may contain a comma, quote, or newline. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
