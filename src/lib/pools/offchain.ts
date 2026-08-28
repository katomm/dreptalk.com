// Pure readers for a pool's off-chain metadata documents, https-only and no I/O.
// The base document carries the registered identity (ticker, name, homepage,
// description) and points to a separate `extended` document, where the logo lives
// under one of two de-facto field paths (current `info.*`, legacy `adapools.*`),
// icon preferred over the larger logo.
import { sanitizeExternalText } from '../validation/input.js';

// Caps for the identity fields. CIP-6 asks for a 5 character ticker, a 50
// character name and a 255 character description, but the documents are written
// by hand and overshoot, so these sit above the spec and only stop the absurd.
const MAX_POOL_TICKER = 16;
const MAX_POOL_NAME = 80;
const MAX_POOL_HOMEPAGE = 200;
const MAX_POOL_DESCRIPTION = 500;

export interface PoolIdentity {
  ticker: string | null;
  name: string | null;
  homepage: string | null;
  description: string | null;
}

export const EMPTY_IDENTITY: PoolIdentity = Object.freeze({
  ticker: null,
  name: null,
  homepage: null,
  description: null,
});

function httpsOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('https://') ? value : null;
}

/** The document as a plain object, or null when it is not parsable JSON object. */
export function parseRecord(text: string): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : null;
}

// Free text out of an untrusted document: control characters stripped, trimmed,
// capped. Still HTML-escaped at render time.
function cleanText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  return sanitizeExternalText(value, maxLen) || null;
}

// A homepage is rendered as a link target, so only the web schemes pass. Pools
// register plain http more often than not, which stays linkable.
function webUrlOrNull(value: unknown): string | null {
  const clean = cleanText(value, MAX_POOL_HOMEPAGE);
  if (!clean) return null;
  return clean.startsWith('https://') || clean.startsWith('http://') ? clean : null;
}

/**
 * Normalizes identity fields from any source, the indexer's parsed copy included.
 * Everything here originates in a document the pool operator controls.
 */
export function sanitizePoolIdentity(raw: {
  ticker?: unknown;
  name?: unknown;
  homepage?: unknown;
  description?: unknown;
}): PoolIdentity {
  return {
    ticker: cleanText(raw.ticker, MAX_POOL_TICKER),
    name: cleanText(raw.name, MAX_POOL_NAME),
    homepage: webUrlOrNull(raw.homepage),
    description: cleanText(raw.description, MAX_POOL_DESCRIPTION),
  };
}

/**
 * Reads the identity out of the base metadata document, the same file the pool
 * registration references on chain. Used as the fallback when the indexer has not
 * resolved (or momentarily loses) its own copy for a pool.
 */
export function extractPoolIdentity(base: Record<string, unknown> | null): PoolIdentity {
  return base ? sanitizePoolIdentity(base) : EMPTY_IDENTITY;
}

export function extractExtendedUrl(base: Record<string, unknown> | null): string | null {
  return base ? httpsOrNull(base.extended) : null;
}

export function extractLogoUrl(extendedJson: unknown): string | null {
  if (typeof extendedJson !== 'object' || extendedJson === null) return null;
  const root = extendedJson as Record<string, unknown>;
  const containers = [root.info, root.adapools].filter(
    (c): c is Record<string, unknown> => typeof c === 'object' && c !== null,
  );
  // Icon (small square) preferred over the larger logo, across both schemas.
  for (const key of ['url_png_icon_64x64', 'url_png_logo']) {
    for (const c of containers) {
      const hit = httpsOrNull(c[key]);
      if (hit) return hit;
    }
  }
  return null;
}
