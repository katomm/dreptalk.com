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
import { sanitizeExternalText } from '../validation/input.js';
import { renderMarkdown } from '../markdown.js';

export const MAX_ANCHOR_BYTES = 100_000;
export const ANCHOR_FETCH_TIMEOUT_MS = 8_000;
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

/** Resolves an on-chain anchor URL to an https URL, or null if unsupported. */
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
  const abstract = sanitizeExternalText(str(body.abstract), MAX_ABSTRACT_LEN);
  // motivation/rationale may carry Markdown; render through the hardened
  // sanitizer (marked + xss). Cap length before rendering.
  const rationaleRaw = sanitizeExternalText(str(body.rationale) || str(body.motivation), MAX_RATIONALE_LEN);

  return {
    title: title || null,
    abstract: abstract || null,
    rationaleHtml: rationaleRaw ? renderMarkdown(rationaleRaw) : null,
  };
}

/**
 * Fetches and verifies a governance-action anchor.
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
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ANCHOR_FETCH_TIMEOUT_MS;

  const resolved = resolveAnchorUrl(anchorUrl);
  if (!resolved) return { status: 'unsupported-url', metadata: null };

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
    if (!res.ok) return { status: 'fetch-failed', metadata: null };
    if (!looksLikeJsonOrText(res.headers.get('content-type'))) {
      return { status: 'bad-content-type', metadata: null };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ANCHOR_BYTES) {
      return { status: 'too-large', metadata: null };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_ANCHOR_BYTES) return { status: 'too-large', metadata: null };
    bytes = new Uint8Array(buf);
  } catch {
    return { status: 'fetch-failed', metadata: null };
  } finally {
    clearTimeout(timer);
  }

  // Mandatory integrity check: the document must hash to the on-chain anchor hash.
  const actualHash = bytesToHex(blake2b256(bytes));
  if (actualHash.toLowerCase() !== anchorHash.trim().toLowerCase()) {
    return { status: 'hash-mismatch', metadata: null };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { status: 'parse-failed', metadata: null };
  }

  return { status: 'ok', metadata: extractCip108(doc) };
}
