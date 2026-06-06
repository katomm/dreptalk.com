// Pure helpers for forum view rendering: pagination, cache headers, relative time, JSON-LD.
// No I/O, no side effects; all functions are deterministic and testable.

/**
 * Parse a page number from a URL query param string.
 * Returns a 1-based page number, min 1, default 1.
 * Ignores garbage input (non-numeric strings, negative numbers, etc.).
 */
export function parsePage(param: string | null): number {
  if (param === null || param === '') return 1;
  const n = parseInt(param, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * Convert a 1-based page number to a zero-based offset for use in SQL OFFSET.
 */
export function pageToOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

/**
 * Returns appropriate Cache-Control header value based on authentication state.
 * Authenticated users get private/no-store to prevent shared-cache poisoning.
 * Anonymous users get a short public cache for edge performance.
 */
export function cacheControlFor(user: unknown | null): string {
  return user ? 'private, no-store' : 'public, s-maxage=30';
}

/**
 * Serialize a value to a JSON string safe for embedding inside a
 * <script type="application/ld+json"> block.
 *
 * The only required escape is `</` -> `<\/`: the JSON spec allows both
 * forms and parsers handle them identically, but the unescaped form ends
 * the enclosing <script> element when a string value contains `</script>`.
 *
 * @param data - Any JSON-serializable value.
 * @returns JSON string with `</` escaped to `<\/`.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/<\//g, '<\\/');
}

/**
 * Format a Unix timestamp (ms) as a human-readable relative time string.
 * Designed for short display next to posts and topic rows.
 *
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "6mo ago", "2y ago"
 */
export function formatRelativeTime(unixMs: number, nowMs: number): string {
  const diffMs = nowMs - unixMs;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return 'just now';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;

  const diffYr = Math.floor(diffDay / 365);
  return `${diffYr}y ago`;
}
