// Off-chain governance-action metadata (CIP-108) fetch and verification.
//
// The anchor URL and hash come from on-chain data and are therefore untrusted.
// Before any of the document is stored or rendered we MUST:
//   1. only fetch http(s)/ipfs URLs (scheme allowlist),
//   2. enforce a request timeout and a response size cap,
//   3. check the content type looks like JSON/text,
//   4. verify blake2b-256(bytes) equals the on-chain anchor hash (integrity),
//   5. sanitize every extracted string before use.
// A broken, oversized, mismatched, or unparseable anchor is tolerated: the
// caller still creates the thread, just without trusted metadata.

import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { sanitizeExternalText, sanitizeExternalMultiline } from '../validation/input.js';
import { renderMarkdown } from '../markdown.js';

// Upper bound on the anchor document we download and hash-verify. Real mainnet
// CIP-108 proposals reach ~1.2MB because the rationale can embed long markdown
// (and occasionally images); a 100KB cap dropped those entirely, losing even the
// title. The stored fields stay bounded (title/abstract/rationale are capped on
// extraction), so this only widens the fetch + hash-verify, not what we persist.
export const MAX_ANCHOR_BYTES = 2_000_000;
export const ANCHOR_FETCH_TIMEOUT_MS = 8_000;

/**
 * Version of the metadata-extraction logic. Bump this constant when the
 * extractor is changed so that existing rows (stored at a lower version) are
 * re-fetched and re-extracted by the backfill on the next sync run. Bumped to 2
 * when MAX_ANCHOR_BYTES was raised, so actions previously marked too-large get
 * their title backfilled.
 */
export const META_EXTRACT_VERSION = 2;

/**
 * How many times the metadata backfill may fail to fetch or verify an action's
 * anchor before it gives up and stops re-attempting that row. At the 15-minute
 * governance cadence this is ~2.5 hours of continuous failure, well past any
 * transient outage, so only a permanently dead or hash-mismatched anchor is
 * abandoned. Giving up keeps the governance sync from being pinned at 'partial'
 * forever and saves a wasted anchor fetch per run. A successful extract resets
 * the counter (see updateActionMetadata).
 */
export const META_REEXTRACT_MAX_ATTEMPTS = 10;
const MAX_TITLE_LEN = 300;
const MAX_ABSTRACT_LEN = 1_000;
const MAX_RATIONALE_LEN = 20_000;

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export interface AnchorMetadata {
  title: string | null;
  abstract: string | null;
  rationaleHtml: string | null;
}

export type AnchorStatus =
  | 'ok'
  | 'unsupported-url'
  | 'fetch-failed'
  | 'too-large'
  | 'bad-content-type'
  | 'hash-mismatch'
  | 'parse-failed';

// Discriminated union: metadata is present only when the status is 'ok'.
export type AnchorResult =
  | { status: 'ok'; metadata: AnchorMetadata }
  | { status: Exclude<AnchorStatus, 'ok'>; metadata: null };

/**
 * Resolves an on-chain URL (anchor document or profile image) to a fetchable
 * URL: http(s) passes through, ipfs://<cid>/<path> maps to the public gateway,
 * anything else is unsupported (null).
 */
function resolveAnchorUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  if (url.protocol === 'ipfs:') {
    // ipfs://<cid>/<path> -> gateway. host holds the CID for ipfs:// URLs.
    const cidPath = (url.host + url.pathname).replace(/^\/+/, '');
    return cidPath ? IPFS_GATEWAY + cidPath : null;
  }
  return null;
}

function looksLikeJsonOrText(contentType: string | null): boolean {
  if (!contentType) return true; // absent: tolerate, the hash check still guards integrity
  const ct = contentType.toLowerCase();
  return ct.includes('json') || ct.includes('text/plain') || ct.includes('octet-stream');
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Extracts title/abstract/rationale from a parsed CIP-108 document. */
function extractCip108(doc: unknown): AnchorMetadata {
  const body = asRecord(asRecord(doc).body);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const title = sanitizeExternalText(str(body.title), MAX_TITLE_LEN);
  // abstract and rationale are prose; use multiline sanitizer so Markdown structure survives.
  const abstract = sanitizeExternalMultiline(str(body.abstract), MAX_ABSTRACT_LEN);
  // motivation/rationale may carry Markdown; render through the hardened
  // sanitizer (marked + xss). Cap length before rendering.
  const rationaleRaw = sanitizeExternalMultiline(str(body.rationale) || str(body.motivation), MAX_RATIONALE_LEN);

  return {
    title: title || null,
    abstract: abstract || null,
    rationaleHtml: rationaleRaw ? renderMarkdown(rationaleRaw) : null,
  };
}

// Character caps for CIP-119 profile fields extracted from untrusted on-chain docs.
const MAX_PROFILE_NAME_LEN = 80;
const MAX_PROFILE_BIO_LEN = 1_000;
const MAX_PROFILE_IMAGE_URL_LEN = 2_048;
const MAX_PROFILE_LINK_LABEL_LEN = 100;
const MAX_PROFILE_LINK_URI_LEN = 2_048;
const MAX_PROFILE_LINKS = 10;

export interface Cip119Profile {
  name: string | null;
  bio: string | null;
  imageUrl: string | null;
  links: { label: string; uri: string }[] | null;
}

/** Returns true for http(s) URLs that parse without error. */
function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Extracts a CIP-119 DRep profile from a parsed, untrusted on-chain metadata doc. */
export function extractCip119Profile(doc: unknown): Cip119Profile {
  // CIP-119 nests all profile fields under a `body` key. Fall back to the root
  // object itself for docs that skip the wrapper (some early DRep registrations).
  const root = asRecord(doc);
  const body = 'body' in root ? asRecord(root.body) : root;

  // name: body.givenName, sanitized and capped.
  const rawName = typeof body.givenName === 'string' ? body.givenName : '';
  const name = sanitizeExternalText(rawName, MAX_PROFILE_NAME_LEN) || null;

  // bio: prefer body.bio, fall back to body.objectives (CIP-119 uses objectives).
  const rawBio =
    (typeof body.bio === 'string' && body.bio) ||
    (typeof body.objectives === 'string' && body.objectives) ||
    '';
  const bio = sanitizeExternalText(rawBio, MAX_PROFILE_BIO_LEN) || null;

  // imageUrl: body.image may be a plain string URL or a CIP-119 ImageObject with
  // contentUrl. http(s) is kept, ipfs:// resolves to the gateway, anything else
  // (data:, javascript:, ...) is dropped. http:// survives extraction but the
  // avatar store is https-only, so it is never fetched or stored.
  let imageUrl: string | null = null;
  const imgField = body.image;
  const imgRecord = imgField && typeof imgField === 'object' ? asRecord(imgField) : null;
  const rawImageUrl =
    typeof imgField === 'string'
      ? imgField
      : typeof imgRecord?.contentUrl === 'string'
        ? imgRecord.contentUrl
        : '';
  if (rawImageUrl) {
    const resolved = resolveAnchorUrl(rawImageUrl);
    if (resolved) imageUrl = resolved.slice(0, MAX_PROFILE_IMAGE_URL_LEN);
  }

  // links: body.references is an array; keep only items with http(s) uri/url.
  let links: { label: string; uri: string }[] | null = null;
  if (Array.isArray(body.references)) {
    const valid = body.references
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .reduce<{ label: string; uri: string }[]>((acc, item) => {
        if (acc.length >= MAX_PROFILE_LINKS) return acc;
        const rawUri = typeof item.uri === 'string' ? item.uri
          : typeof item.url === 'string' ? item.url
          : '';
        if (!isHttpUrl(rawUri)) return acc;
        const uri = rawUri.slice(0, MAX_PROFILE_LINK_URI_LEN);
        const rawLabel = typeof item.label === 'string' ? item.label
          : typeof item.name === 'string' ? item.name
          : typeof item['@type'] === 'string' ? item['@type']
          : '';
        const label = sanitizeExternalText(rawLabel, MAX_PROFILE_LINK_LABEL_LEN);
        acc.push({ label, uri });
        return acc;
      }, []);
    links = valid.length > 0 ? valid : null;
  }

  return { name, bio, imageUrl, links };
}

// Discriminated union returning the raw parsed doc on success. The doc is the
// untrusted JSON value; callers MUST run a field extractor (extractCip108 or
// extractCip119Profile) that sanitizes before storing or rendering anything.
export type AnchorDocResult =
  | { status: 'ok'; doc: unknown }
  | { status: Exclude<AnchorStatus, 'ok'>; doc: null };

/**
 * Fetches, verifies, and parses an on-chain anchor, returning the raw JSON doc.
 *
 * This is the shared security pipeline (scheme allowlist, timeout, size cap,
 * content-type check, mandatory blake2b-256 hash verification, JSON parse) used
 * by both the CIP-108 governance-action path and the CIP-119 DRep-profile path.
 * It performs no field extraction: the returned doc is untrusted.
 *
 * @param anchorUrl  on-chain anchor URL (untrusted)
 * @param anchorHash on-chain blake2b-256 hash, hex (untrusted but authoritative)
 * @param deps       injectable fetch + timeout for testing
 */
export async function fetchAnchorDoc(
  anchorUrl: string,
  anchorHash: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AnchorDocResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ANCHOR_FETCH_TIMEOUT_MS;

  const resolved = resolveAnchorUrl(anchorUrl);
  if (!resolved) return { status: 'unsupported-url', doc: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let bytes: Uint8Array;
  try {
    const res = await fetchImpl(resolved, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'application/json, text/plain' },
    });
    if (!res.ok) return { status: 'fetch-failed', doc: null };
    if (!looksLikeJsonOrText(res.headers.get('content-type'))) {
      return { status: 'bad-content-type', doc: null };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ANCHOR_BYTES) {
      return { status: 'too-large', doc: null };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_ANCHOR_BYTES) return { status: 'too-large', doc: null };
    bytes = new Uint8Array(buf);
  } catch {
    return { status: 'fetch-failed', doc: null };
  } finally {
    clearTimeout(timer);
  }

  // Mandatory integrity check: the document must hash to the on-chain anchor hash.
  const actualHash = bytesToHex(blake2b256(bytes));
  if (actualHash.toLowerCase() !== anchorHash.trim().toLowerCase()) {
    return { status: 'hash-mismatch', doc: null };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { status: 'parse-failed', doc: null };
  }

  return { status: 'ok', doc };
}

/**
 * Fetches and verifies a governance-action anchor, returning CIP-108 metadata.
 *
 * @param anchorUrl  on-chain anchor URL (untrusted)
 * @param anchorHash on-chain blake2b-256 hash, hex (untrusted but authoritative)
 * @param deps       injectable fetch + timeout for testing
 */
export async function fetchAnchorMetadata(
  anchorUrl: string,
  anchorHash: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AnchorResult> {
  const result = await fetchAnchorDoc(anchorUrl, anchorHash, deps);
  if (result.status !== 'ok') return { status: result.status, metadata: null };
  return { status: 'ok', metadata: extractCip108(result.doc) };
}
