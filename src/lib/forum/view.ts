// Pure helpers for forum view rendering: pagination, cache headers, relative time, JSON-LD.
// No I/O, no side effects; all functions are deterministic and testable.

import { formatAda as adaFull, formatAdaCompact as adaCompact } from '../format/ada.js';

/** Canonical origin for the site, used as fallback when Astro.site is not configured. */
export const SITE_ORIGIN = 'https://dreptalk.com';

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
 * Truncates a long id (e.g. a stake address) to at most `len` characters,
 * appending "..." when truncation occurs. Default len is 16.
 */
export function truncateId(id: string, len = 16): string {
  return id.length > len ? `${id.slice(0, len)}...` : id;
}

/**
 * Middle truncation for a long id: keeps the bech32 prefix and the distinctive
 * tail (e.g. "drep1yf3y...0hks02d7"). Ids short enough to show whole pass
 * through unchanged.
 */
export function truncateIdMiddle(id: string, head = 9, tail = 8): string {
  return id.length > head + tail + 3 ? `${id.slice(0, head)}...${id.slice(-tail)}` : id;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 1 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * Decodes the HTML entities that survive tag-stripping (numeric, hex, and the
 * common named ones) into real characters, so a plain-text excerpt reads as text
 * ("It's", not "It&#39;s"). A single /g pass never re-scans its own output, so
 * "&amp;lt;" decodes to "&lt;" rather than "<".
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(Number.parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => NAMED_ENTITIES[name]);
}

/**
 * Strips HTML tags, decodes entities to plain text, collapses whitespace, and
 * truncates to `maxLen` characters (appending "..." when truncated). For
 * plain-text meta descriptions and JSON-LD text derived from sanitized post HTML.
 */
export function excerptFromHtml(html: string, maxLen = 155): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}...` : text;
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

/**
 * Whole ADA with the ₳ symbol and thousands separators (rounded; profiles never
 * do exact accounting). Null is treated as 0. Thin wrapper over the canonical
 * {@link adaFull} that keeps the always-a-string, "0 ₳"-on-absent contract these
 * profile/directory views rely on.
 */
export function formatAda(lovelace: string | null): string {
  return adaFull(lovelace) ?? '0 ₳';
}

/**
 * Like {@link formatAda} but abbreviates large amounts (200K, 2.5M, 1.3B) so the
 * voting power fits where horizontal space is tight, e.g. the DRep table on
 * mobile. Null is treated as 0.
 */
export function formatAdaCompact(lovelace: string | null): string {
  return adaCompact(lovelace) ?? '0 ₳';
}

/**
 * Cache-Control for sync-driven anonymous pages (DRep profiles, directory).
 * They change only on the drep-sync cron (~6h), not per request, so they take a
 * longer edge TTL than the 30s forum threads. Logged-in users are never cached.
 */
export function cacheControlForSynced(user: unknown | null): string {
  return user ? 'private, no-store' : 'public, s-maxage=300';
}
