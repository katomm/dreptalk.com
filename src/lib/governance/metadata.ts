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
import { bytesToHex, HEX_HASH_256_RE } from '../crypto/hex.js';
import { sanitizeExternalText, sanitizeExternalMultiline } from '../validation/input.js';
import { renderMarkdown } from '../markdown.js';
import { isCardanoPaymentAddress } from '../cardano/identity.js';

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
 * their title backfilled. Bumped to 3 when the extractor started merging
 * motivation + rationale (instead of dropping motivation) and the abstract/rationale
 * caps were raised, so every existing row re-renders with the full body.
 */
export const META_EXTRACT_VERSION = 3;

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
// Abstract is the always-visible lede of a governance action (it is the fold line
// above the collapsible rationale), so it must not be cut mid-sentence: most
// mainnet abstracts run 1-2.5k chars. Rationale merges motivation + rationale and
// is deposit-gated (100k ADA per action), so spam risk is negligible; the 100k cap
// is purely a page-weight guard against the rare multi-hundred-KB outlier.
const MAX_ABSTRACT_LEN = 4_000;
const MAX_RATIONALE_LEN = 100_000;

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
 * anything else is unsupported (null). Exported so display surfaces can link
 * the anchor somewhere a browser can actually open (no ipfs: handler exists
 * for most users).
 */
export function resolveAnchorUrl(raw: string): string | null {
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

/**
 * Unwraps a JSON-LD value object ({"@value": x}) to x; passes any other value
 * through unchanged. CIP-100/CIP-119 are JSON-LD, so a field may be written in
 * the compact form ("givenName": "Will Norris") or the expanded value-object
 * form ("givenName": {"@value": "Will Norris"}). Both are semantically identical
 * and several real mainnet DReps register with the expanded form.
 */
function jsonLdValue(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && '@value' in v) {
    return (v as Record<string, unknown>)['@value'];
  }
  return v;
}

/**
 * Reads a string from a JSON-LD field in either compact or expanded form, or
 * null when the field holds no string (absent or a non-string). Distinguishes an
 * absent field from a present empty string, which matters for a precedence chain
 * that must keep an explicit "" rather than fall through to the next candidate.
 */
function jsonLdStringOrNull(v: unknown): string | null {
  const u = jsonLdValue(v);
  return typeof u === 'string' ? u : null;
}

/** Reads a string from a JSON-LD field in either compact or expanded form; '' otherwise. */
function jsonLdString(v: unknown): string {
  return jsonLdStringOrNull(v) ?? '';
}

/**
 * Extracts title/abstract/rationale from a parsed CIP-108 document.
 *
 * `anchorUrl` (the untrusted on-chain anchor) is only used to build the "read the
 * full document" link appended when the merged body is truncated at the cap.
 */
function extractCip108(doc: unknown, anchorUrl?: string): AnchorMetadata {
  const body = asRecord(asRecord(doc).body);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const title = sanitizeExternalText(str(body.title), MAX_TITLE_LEN);
  // abstract and rationale are prose; use multiline sanitizer so Markdown structure survives.
  const abstract = sanitizeExternalMultiline(str(body.abstract), MAX_ABSTRACT_LEN);

  // CIP-108 defines `motivation` and `rationale` as two separate fields, and
  // proposers routinely split one document across both (motivation = intro/early
  // sections, rationale = later sections). Merge them in document order so nothing
  // is dropped; the old `rationale || motivation` silently discarded the motivation
  // whenever a rationale was present. Dedupe the occasional doc that puts identical
  // text in both fields. motivation/rationale may carry Markdown; render through the
  // hardened sanitizer (marked + xss). Cap length before rendering.
  const motivation = str(body.motivation).trim();
  const rationale = str(body.rationale).trim();
  const merged = (motivation && motivation === rationale ? [rationale] : [motivation, rationale].filter(Boolean)).join(
    '\n\n',
  );
  let rationaleRaw = sanitizeExternalMultiline(merged, MAX_RATIONALE_LEN);
  // The cap slices at MAX_RATIONALE_LEN, so hitting it means the tail was dropped.
  // Tell the reader and point at the on-chain anchor for the complete document.
  if (rationaleRaw.length >= MAX_RATIONALE_LEN) {
    const link = anchorUrl ? resolveAnchorUrl(anchorUrl) : null;
    rationaleRaw += link
      ? `\n\n*Content truncated. Read the full document at the [on-chain anchor](${link}).*`
      : '\n\n*Content truncated. See the on-chain anchor for the full document.*';
  }

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
// Cap on an inline base64 data: image kept for the avatar store to decode. Sized
// to admit up to a ~10 MB image (base64 inflates by ~4/3); the avatar store
// enforces the real byte limit on the decoded result. Bounds memory so a
// pathological multi-MB string never rides along in the resolved profile.
const MAX_PROFILE_IMAGE_DATA_LEN = 14_000_000;
const MAX_PROFILE_LINK_LABEL_LEN = 100;
const MAX_PROFILE_LINK_URI_LEN = 2_048;
const MAX_PROFILE_LINKS = 10;
const MAX_PROFILE_MOTIVATIONS_LEN = 1_000;
const MAX_PROFILE_QUALIFICATIONS_LEN = 1_000;
const MAX_PROFILE_PAYMENT_ADDR_LEN = 150;

export interface Cip119Profile {
  name: string | null;
  bio: string | null;
  imageUrl: string | null;
  /**
   * A base64 `data:` image embedded directly in the metadata doc, kept verbatim
   * for the avatar store to decode and persist. Mutually exclusive with imageUrl
   * (a data: image is never a fetchable URL). Null for linked or absent images.
   */
  imageDataUri: string | null;
  /** sha256 (64 hex) of the image bytes, when the ImageObject carries one. */
  imageSha256: string | null;
  links: { label: string; uri: string }[] | null;
  motivations: string | null;
  qualifications: string | null;
  paymentAddress: string | null;
  doNotList: boolean;
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

/**
 * Version of the CIP-119 profile extractor. Stored per DRep row; the sync reuses
 * a stored profile without re-fetching its anchor ONLY when the row was extracted
 * at the current version. Bump this when extractCip119Profile changes in a way
 * that would produce different output for the same document, so existing rows are
 * re-fetched and re-extracted once over the next few sync runs (bounded by the
 * per-run anchor budget). Bumped to 1 when the extractor learned to unwrap the
 * JSON-LD expanded @value form, healing every DRep whose name/bio/links were
 * previously dropped for using that encoding.
 */
export const PROFILE_EXTRACT_VERSION = 1;

/** Extracts a CIP-119 DRep profile from a parsed, untrusted on-chain metadata doc. */
export function extractCip119Profile(doc: unknown): Cip119Profile {
  // CIP-119 nests all profile fields under a `body` key. Fall back to the root
  // object itself for docs that skip the wrapper (some early DRep registrations).
  const root = asRecord(doc);
  const body = 'body' in root ? asRecord(root.body) : root;

  // name: body.givenName, sanitized and capped. Unwrap the JSON-LD @value form.
  const name = sanitizeExternalText(jsonLdString(body.givenName), MAX_PROFILE_NAME_LEN) || null;

  // bio: prefer body.bio, fall back to body.objectives (CIP-119 uses objectives).
  const rawBio = jsonLdString(body.bio) || jsonLdString(body.objectives);
  const bio = sanitizeExternalMultiline(rawBio, MAX_PROFILE_BIO_LEN) || null;

  // image: body.image may be a plain string URL or a CIP-119 ImageObject with
  // contentUrl. http(s) is kept as imageUrl, ipfs:// resolves to the gateway, a
  // base64 data: URI is kept verbatim as imageDataUri for the avatar store to
  // decode, and anything else (javascript:, ...) is dropped. http:// survives as
  // a URL but the avatar store is https-only, so it is never fetched or stored.
  let imageUrl: string | null = null;
  let imageDataUri: string | null = null;
  const imgField = body.image;
  const imgRecord = imgField && typeof imgField === 'object' ? asRecord(imgField) : null;
  // image may be a plain string URL, a @value-wrapped string, or an ImageObject
  // whose contentUrl is itself either a plain string or @value-wrapped.
  const rawImageUrl = jsonLdString(imgField) || jsonLdString(imgRecord?.contentUrl);
  if (rawImageUrl.startsWith('data:')) {
    if (rawImageUrl.length <= MAX_PROFILE_IMAGE_DATA_LEN) imageDataUri = rawImageUrl;
  } else if (rawImageUrl) {
    const resolved = resolveAnchorUrl(rawImageUrl);
    if (resolved) imageUrl = resolved.slice(0, MAX_PROFILE_IMAGE_URL_LEN);
  }

  // imageSha256: the ImageObject may carry the sha256 of the bytes. Our own
  // uploads embed it (and the bytes live in R2 under that key), so a consumer
  // can serve the image directly without re-downloading.
  const rawSha256 = jsonLdString(imgRecord?.sha256);
  const imageSha256 = HEX_HASH_256_RE.test(rawSha256) ? rawSha256 : null;

  // links: body.references is an array; keep only items with http(s) uri/url.
  let links: { label: string; uri: string }[] | null = null;
  if (Array.isArray(body.references)) {
    const valid = body.references
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .reduce<{ label: string; uri: string }[]>((acc, item) => {
        if (acc.length >= MAX_PROFILE_LINKS) return acc;
        const rawUri = jsonLdString(item.uri) || jsonLdString(item.url);
        if (!isHttpUrl(rawUri)) return acc;
        const uri = rawUri.slice(0, MAX_PROFILE_LINK_URI_LEN);
        // Precedence label -> name -> @type; an explicit "" label is kept (?? not ||)
        // rather than falling through, matching the pre-@value behavior.
        const rawLabel =
          jsonLdStringOrNull(item.label) ?? jsonLdStringOrNull(item.name) ?? jsonLdString(item['@type']);
        const label = sanitizeExternalText(rawLabel, MAX_PROFILE_LINK_LABEL_LEN);
        acc.push({ label, uri });
        return acc;
      }, []);
    links = valid.length > 0 ? valid : null;
  }

  const motivations =
    sanitizeExternalMultiline(jsonLdString(body.motivations), MAX_PROFILE_MOTIVATIONS_LEN) || null;
  const qualifications =
    sanitizeExternalMultiline(jsonLdString(body.qualifications), MAX_PROFILE_QUALIFICATIONS_LEN) || null;
  const rawPay = jsonLdString(body.paymentAddress).trim();
  const paymentAddress =
    rawPay.length > 0 && rawPay.length <= MAX_PROFILE_PAYMENT_ADDR_LEN && isCardanoPaymentAddress(rawPay)
      ? rawPay
      : null;
  const dnl = jsonLdValue(body.doNotList);
  const doNotList = dnl === true || dnl === 'true';

  return { name, bio, imageUrl, imageDataUri, imageSha256, links, motivations, qualifications, paymentAddress, doNotList };
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
  return { status: 'ok', metadata: extractCip108(result.doc, anchorUrl) };
}
