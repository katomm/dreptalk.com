/// <reference types="@cloudflare/workers-types" />
// Self-hosted document short circuit.
//
// URLs minted by our own flows point back at this site: CIP-119 profile docs at
// /drep/<hash>.json (drepMetadataHandler), vote rationales at
// /vote-rationale/<hash>.json (voteRationaleHandler), and uploaded avatars at
// /api/avatar/<hash> (drepImageHandler). Fetching any of them from a Worker is a
// same-zone subrequest: Cloudflare's loop prevention bypasses our Worker and
// connects to the placeholder origin DNS record, a blackhole that times out as a
// 504. Every consumer that resolves such URLs must therefore read the content
// from its store (D1 or R2) instead of HTTP. This module centralizes the URL
// detection and the D1-backed anchor-document read.

import { verifyAnchorDoc, fetchAnchorDoc, type AnchorDocResult } from './metadata.js';
import { getDrepMetadataByHash } from '../db/drepMetadata.js';
import { getVoteRationaleBody } from '../db/voteRationale.js';

export type SelfHostedRef =
  | { kind: 'drep-metadata'; hash: string }
  | { kind: 'vote-rationale'; hash: string }
  | { kind: 'avatar'; hash: string };

// Path shapes mirror the serving routes exactly (lowercase 64-hex, like their
// HASH_RE): a URL the route would 404 must resolve the same way here.
const DREP_DOC_RE = /^\/drep\/([0-9a-f]{64})\.json$/;
const VOTE_RATIONALE_RE = /^\/vote-rationale\/([0-9a-f]{64})\.json$/;
const AVATAR_RE = /^\/api\/avatar\/([0-9a-f]{64})$/;

/** Parses an http(s) URL on our own zone (any host), or null. */
function selfZoneUrl(rawUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'dreptalk.com' && !host.endsWith('.dreptalk.com')) return null;
  return url;
}

/**
 * Whether the URL points at our own zone at all, regardless of path. Consumers
 * use this to fail fast on self-zone URLs that carry no readable content (the
 * doomed same-zone fetch would only hang and 504).
 */
export function isSelfZoneUrl(rawUrl: string): boolean {
  return selfZoneUrl(rawUrl) != null;
}

/**
 * Classifies a URL as one of our own hosted-content endpoints, or null for any
 * foreign URL. Matches dreptalk.com and every subdomain (preprod.dreptalk.com),
 * since same-zone loop prevention affects all hosts on the zone, and both http
 * and https (broken plain-http registrations exist on chain).
 */
export function selfHostedRef(rawUrl: string): SelfHostedRef | null {
  const url = selfZoneUrl(rawUrl);
  if (!url) return null;

  let m = DREP_DOC_RE.exec(url.pathname);
  if (m) return { kind: 'drep-metadata', hash: m[1] };
  m = VOTE_RATIONALE_RE.exec(url.pathname);
  if (m) return { kind: 'vote-rationale', hash: m[1] };
  m = AVATAR_RE.exec(url.pathname);
  if (m) return { kind: 'avatar', hash: m[1] };
  return null;
}

/**
 * Resolves an anchor document: self-hosted URLs are read from their D1 table
 * and run through the same hash verification + parse pipeline as a fetched
 * document, foreign URLs go through fetchAnchorDoc unchanged.
 *
 * A self-hosted URL with no readable document (row missing, or an /api/avatar
 * URL, which holds image bytes rather than a JSON document) maps to
 * 'fetch-failed', exactly what the serving route's 404 would mean. The lookup
 * key is the hash in the URL path (how the route addresses the content);
 * verification is against the on-chain anchorHash.
 */
export async function fetchOrReadAnchorDoc(
  db: D1Database,
  anchorUrl: string,
  anchorHash: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AnchorDocResult> {
  const ref = selfHostedRef(anchorUrl);
  if (!ref) return fetchAnchorDoc(anchorUrl, anchorHash, deps);

  const body =
    ref.kind === 'drep-metadata'
      ? ((await getDrepMetadataByHash(db, ref.hash))?.body ?? null)
      : ref.kind === 'vote-rationale'
        ? await getVoteRationaleBody(db, ref.hash)
        : null;
  if (body == null) return { status: 'fetch-failed', doc: null };
  return verifyAnchorDoc(new TextEncoder().encode(body), anchorHash);
}
