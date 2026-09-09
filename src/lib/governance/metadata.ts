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
import { readBodyLimited } from '../http/bodyLimit.js';
import { bytesToHex, HEX_HASH_256_RE } from '../crypto/hex.js';
import {
  MAX_EXTERNAL_PROSE_LEN,
  MAX_EXTERNAL_TITLE_LEN,
  sanitizeExternalText,
  sanitizeExternalMultiline,
} from '../validation/input.js';
import { renderMarkdown } from '../markdown.js';
import { isCardanoPaymentAddress } from '../cardano/identity.js';
import { selfHostedRef, readSelfHostedBody } from './selfHostedDocs.js';
import { dedupeLinks, type DocumentLink } from './documentLinks.js';

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
 * Bumped to 4 when the extractor started reading the top-level authors array.
 * Bumped to 5 when it started reading body.references, so existing rows pick up
 * the proposer's own supporting links without a manual backfill.
 */
export const META_EXTRACT_VERSION = 5;

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
// Rationale merges motivation + rationale and is deposit-gated (100k ada per
// action), so spam risk is negligible; the 100k cap is purely a page-weight
// guard against the rare multi-hundred-KB outlier. Title and abstract (the
// always-visible lede, the fold line above the collapsible rationale) take the
// shared external-text caps.
const MAX_RATIONALE_LEN = 100_000;
// Author names are a self-declared label in an untrusted document, so they are
// capped hard: 80 chars covers the longest real mainnet name (58) with headroom,
// and 10 entries covers the largest real co-signed action (5).
const MAX_AUTHOR_NAME_LEN = 80;
const MAX_AUTHORS = 10;
// CIP-108 body.references: the proposer's own supporting links. Foreign
// documents (GovTool submissions) routinely carry more than our own submit cap
// of 10, so the read side admits 20 before truncating. The URI cap matches the
// profile-link cap; the label cap is looser than a profile link's because
// proposal references are often a sentence-long citation rather than a name.
const MAX_REFERENCE_LABEL_LEN = 200;
const MAX_REFERENCE_URI_LEN = 2_048;
const MAX_REFERENCES = 20;

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/**
 * One entry of CIP-108 `body.references`, reduced to what we display. The `uri`
 * is untrusted chain input restricted to http(s)/ipfs on extraction; `label` may
 * be empty when the document supplies none, and the display falls back to the
 * URI itself rather than inventing a title. `referenceHash` is spec-optional and
 * deliberately neither read nor stored: we do not fetch these links, so a hash we
 * never verify would only look like an assurance.
 */
export interface AnchorReference {
  label: string;
  uri: string;
}

export interface AnchorMetadata {
  title: string | null;
  abstract: string | null;
  rationaleHtml: string | null;
  /** Self-declared author names from the document's top-level authors array. */
  authors: string[] | null;
  /** Supporting links from body.references, or null when the doc carries none. */
  references: AnchorReference[] | null;
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
export function jsonLdValue(v: unknown): unknown {
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
 * Reads the top-level CIP-100 authors array down to a list of display names.
 * The names are self-reported and unverified: a witness signature proves only
 * that some key signed the document, never that the key belongs to the claimed
 * name, so nothing here is treated as an identity. Callers decide when a name is
 * safe to show.
 */
function extractAuthorNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    const name = sanitizeExternalText(jsonLdString(asRecord(entry).name), MAX_AUTHOR_NAME_LEN);
    if (name) names.push(name);
    if (names.length === MAX_AUTHORS) break;
  }
  return names.length ? names : null;
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
 * Per-caller policy for reading a JSON-LD `body.references` array. Both on-chain
 * document surfaces carry the same shape but bound it differently: a CIP-119
 * DRep profile keeps http(s) only and lets `@type` stand in for a missing label,
 * a CIP-108 governance action also admits ipfs: and collapses duplicates.
 */
export interface ReferenceListPolicy {
  /** How many entries survive. The rest of the array is ignored. */
  maxItems: number;
  /** Label cap, applied by the shared external-text sanitizer. */
  maxLabelLen: number;
  /**
   * URI cap. An entry above it is DROPPED, never truncated: a sliced URL still
   * renders as a working link, it just points at a different resource than the
   * document meant, which is worse than showing no link at all.
   */
  maxUriLen: number;
  /** Whether ipfs: URIs are kept. They are stored raw and resolved for display. */
  allowIpfs: boolean;
  /** Label fields in precedence order. The first one present wins, "" included. */
  labelKeys: readonly string[];
  /** Collapse repeated URIs before the cap, so one link listed many times cannot
   *  crowd the distinct ones out. Off where the display surface dedupes itself. */
  dedupe?: boolean;
}

// A document may list thousands of entries. Scanning a bounded multiple of the
// cap is enough to fill it with distinct links without walking a 2MB array.
const REFERENCE_SCAN_FACTOR = 10;

/**
 * Reads a JSON-LD `body.references` array down to the label/uri pairs we show,
 * under the caller's caps and scheme set. Shared by the CIP-119 DRep profile and
 * the CIP-108 governance-action paths, which read the identical shape out of two
 * different untrusted documents.
 *
 * What is stored is the RAW uri, not a resolved gateway form, so changing how an
 * ipfs: link is resolved stays a display decision and needs no re-extract.
 *
 * Returns null (not []) when the field is absent or nothing survives, so callers
 * can tell "no references" from "references we refused".
 */
export function readReferenceList(raw: unknown, policy: ReferenceListPolicy): DocumentLink[] | null {
  if (!Array.isArray(raw)) return null;
  const found: DocumentLink[] = [];
  for (const entry of raw.slice(0, policy.maxItems * REFERENCE_SCAN_FACTOR)) {
    // Without dedupe the cap is reached for good. With it, later entries may
    // still contribute a label to an earlier duplicate.
    if (!policy.dedupe && found.length >= policy.maxItems) break;
    const item = asRecord(entry);
    // CIP-108 names the field `uri`, CIP-119 profiles in the wild also use `url`.
    const uri = (jsonLdString(item.uri) || jsonLdString(item.url)).trim();
    if (!uri || uri.length > policy.maxUriLen) continue;
    // resolveAnchorUrl doubles as the ipfs validity test on purpose: it is the
    // same allowlist the anchor fetch uses, so a display surface can never be
    // handed a URI the resolver would later refuse.
    if (!(policy.allowIpfs ? resolveAnchorUrl(uri) !== null : isHttpUrl(uri))) continue;
    // An explicit empty label is kept rather than falling through to the next
    // key: the display falls back to the URI, which is honest, where an invented
    // label would not be.
    let rawLabel: string | null = null;
    for (const key of policy.labelKeys) {
      rawLabel = jsonLdStringOrNull(item[key]);
      if (rawLabel !== null) break;
    }
    found.push({ label: sanitizeExternalText(rawLabel ?? '', policy.maxLabelLen), uri });
  }
  const kept = (policy.dedupe ? dedupeLinks(found) : found).slice(0, policy.maxItems);
  return kept.length > 0 ? kept : null;
}

/**
 * Reads CIP-108 `body.references` down to the label/uri pairs we display.
 *
 * Every field here is untrusted chain input, so: the URI must parse and use a
 * scheme we can actually link (`resolveAnchorUrl` is the same allowlist the
 * anchor fetch uses, http(s) and ipfs), entries without one are dropped rather
 * than rendered as dead text, and the list is truncated at MAX_REFERENCES. The
 * raw URI is stored, not the gateway form, so the display can decide how to
 * resolve an ipfs:// link later without a re-extract.
 */
function extractReferences(raw: unknown): AnchorReference[] | null {
  if (!Array.isArray(raw)) return null;
  const refs: AnchorReference[] = [];
  for (const entry of raw) {
    if (refs.length === MAX_REFERENCES) break;
    const item = asRecord(entry);
    // CIP-108 names the field `uri`; tolerate `url` as CIP-119 profiles do.
    const rawUri = (jsonLdString(item.uri) || jsonLdString(item.url)).trim();
    if (!rawUri || rawUri.length > MAX_REFERENCE_URI_LEN) continue;
    if (!resolveAnchorUrl(rawUri)) continue;
    // An explicit empty label is kept: the card falls back to showing the URI,
    // which is honest, where a made-up label would not be.
    const rawLabel = jsonLdStringOrNull(item.label) ?? jsonLdString(item.name);
    refs.push({ label: sanitizeExternalText(rawLabel, MAX_REFERENCE_LABEL_LEN), uri: rawUri });
  }
  return refs.length ? refs : null;
}

/**
 * Extracts title/abstract/rationale from a parsed CIP-108 document.
 *
 * `anchorUrl` (the untrusted on-chain anchor) is only used to build the "read the
 * full document" link appended when the merged body is truncated at the cap.
 */
function extractCip108(doc: unknown, anchorUrl?: string): AnchorMetadata {
  const root = asRecord(doc);
  const body = asRecord(root.body);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const title = sanitizeExternalText(str(body.title), MAX_EXTERNAL_TITLE_LEN);
  // abstract and rationale are prose; use multiline sanitizer so Markdown structure survives.
  const abstract = sanitizeExternalMultiline(str(body.abstract), MAX_EXTERNAL_PROSE_LEN);

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
    authors: extractAuthorNames(root.authors),
    references: extractReferences(body.references),
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
  links: DocumentLink[] | null;
  motivations: string | null;
  qualifications: string | null;
  paymentAddress: string | null;
  doNotList: boolean;
}

/**
 * Version of the CIP-119 profile extractor. Stored per DRep row; the sync reuses
 * a stored profile without re-fetching its anchor ONLY when the row was extracted
 * at the current version. Bump this when extractCip119Profile changes in a way
 * that would produce different output for the same document, so existing rows are
 * re-fetched and re-extracted once over the next few sync runs (bounded by the
 * per-run anchor budget). Bumped to 1 when the extractor learned to unwrap the
 * JSON-LD expanded @value form, healing every DRep whose name/bio/links were
 * previously dropped for using that encoding. Bumped to 2 when an over-long link
 * URI started being dropped instead of truncated, so every profile that stored a
 * sliced URL (a working link pointing at the wrong resource) is re-extracted.
 */
export const PROFILE_EXTRACT_VERSION = 2;

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

  // links: body.references, http(s) only. Duplicates are left in place. The
  // profile page collapses them at render, where it also picks the best label.
  const links = readReferenceList(body.references, {
    maxItems: MAX_PROFILE_LINKS,
    maxLabelLen: MAX_PROFILE_LINK_LABEL_LEN,
    maxUriLen: MAX_PROFILE_LINK_URI_LEN,
    allowIpfs: false,
    // CIP-119 docs commonly carry an @type ("Link", "Identity") and no label at
    // all, so the profile path falls back to it where the CIP-108 path does not.
    labelKeys: ['label', 'name', '@type'],
  });

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

// Shared encoder for hash checks; stateless, so one instance serves all calls.
const TEXT_ENCODER = new TextEncoder();

/**
 * Fetches, verifies, and parses an on-chain anchor, returning the raw JSON doc.
 *
 * This is the shared security pipeline (scheme allowlist, timeout, size cap,
 * content-type check, mandatory blake2b-256 hash verification, JSON parse) used
 * by both the CIP-108 governance-action path and the CIP-119 DRep-profile path.
 * It performs no field extraction: the returned doc is untrusted.
 *
 * Anchor URLs on our own zone never go over HTTP (a same-zone Worker fetch
 * blackholes, see selfHostedDocs.ts): with `db` present, hosted documents are
 * read from D1 and verified through the same pipeline; anything else self-zone
 * maps to 'fetch-failed' immediately, which is all the doomed fetch could ever
 * produce, minus the timeout.
 *
 * @param anchorUrl  on-chain anchor URL (untrusted)
 * @param anchorHash on-chain blake2b-256 hash, hex (untrusted but authoritative)
 * @param deps       injectable fetch + timeout for testing, plus the D1 handle
 *                   for self-hosted document reads
 */
export async function fetchAnchorDoc(
  anchorUrl: string,
  anchorHash: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number; db?: D1Database } = {},
): Promise<AnchorDocResult> {
  const self = selfHostedRef(anchorUrl);
  if (self) {
    const body = deps.db ? await readSelfHostedBody(deps.db, self) : null;
    if (body == null) return { status: 'fetch-failed', doc: null };
    return verifyAnchorDoc(TEXT_ENCODER.encode(body), anchorHash);
  }

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
    // Content-Length is only a fast path; the bounded reader enforces the cap
    // even for chunked or lying senders without buffering past the limit.
    const read = await readBodyLimited(res.body, MAX_ANCHOR_BYTES);
    if (!read.ok) return { status: 'too-large', doc: null };
    bytes = read.bytes;
  } catch {
    return { status: 'fetch-failed', doc: null };
  } finally {
    clearTimeout(timer);
  }

  return verifyAnchorDoc(bytes, anchorHash);
}

/**
 * Verifies raw document bytes against the on-chain blake2b-256 anchor hash and
 * parses them as JSON. Shared by fetchAnchorDoc and the self-hosted short
 * circuit in the dreps sync, so a body read straight from D1 passes the exact
 * same integrity pipeline as a fetched one. The returned doc is untrusted.
 */
export function verifyAnchorDoc(bytes: Uint8Array, anchorHash: string): AnchorDocResult {
  // Mandatory integrity check: the document must hash to the on-chain anchor hash.
  const want = anchorHash.trim().toLowerCase();
  const rawMatches = bytesToHex(blake2b256(bytes)).toLowerCase() === want;

  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Non-JSON body: only the raw bytes can be verified.
    return rawMatches ? { status: 'parse-failed', doc: null } : { status: 'hash-mismatch', doc: null };
  }

  // Some anchoring tools (e.g. cgov.io) hash a pretty-printed serialization of the
  // JSON but publish the minified bytes (or the reverse). The document is then
  // byte-identical to the anchored one except for insignificant JSON whitespace,
  // so the raw-byte hash misses while the content is genuinely the committed one.
  // Re-serialize the parsed document in the common canonical forms and accept it
  // only if one of them hashes to the on-chain anchor. This keeps the guarantee
  // intact: we still require an exact blake2b-256 match against the authoritative
  // hash, so a different document can never pass; we merely tolerate reformatting.
  const verified = rawMatches || matchesReserialized(doc, want);
  if (!verified) return { status: 'hash-mismatch', doc: null };

  return { status: 'ok', doc };
}

// Whether any canonical re-serialization of `doc` hashes to the wanted anchor
// hash. Covers minified and 2-/4-space pretty printing, the forms real anchoring
// tools emit; JSON.stringify preserves key insertion order from the parse, so a
// whitespace-only reformat round-trips to the exact anchored bytes.
function matchesReserialized(doc: unknown, want: string): boolean {
  for (const serialized of [JSON.stringify(doc), JSON.stringify(doc, null, 2), JSON.stringify(doc, null, 4)]) {
    if (serialized && bytesToHex(blake2b256(TEXT_ENCODER.encode(serialized))).toLowerCase() === want) return true;
  }
  return false;
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
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number; db?: D1Database } = {},
): Promise<AnchorResult> {
  const result = await fetchAnchorDoc(anchorUrl, anchorHash, deps);
  if (result.status !== 'ok') return { status: result.status, metadata: null };
  return { status: 'ok', metadata: extractCip108(result.doc, anchorUrl) };
}
