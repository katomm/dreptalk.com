/// <reference types="@cloudflare/workers-types" />
// Self-hosted URL classification and document reads.
//
// URLs minted by our own flows point back at this site: CIP-119 profile docs at
// /drep/<hash>.json (drepMetadataHandler), vote rationales at
// /vote-rationale/<hash>.json (voteRationaleHandler), and uploaded avatars at
// /api/avatar/<hash> (drepImageHandler). Fetching ANY URL on our own zone from
// a Worker is a same-zone subrequest: Cloudflare's loop prevention bypasses our
// Worker and connects to the placeholder origin DNS record, a blackhole that
// times out as a 504. So self-zone content must always come from its store (D1
// or R2), and a self-zone URL with no readable store must fail fast rather than
// hang through a doomed fetch. fetchAnchorDoc (metadata.ts) applies this to
// every anchor consumer; the avatar passes apply it to image URLs.

import { HEX_64_SOURCE } from '../crypto/hex.js';
import { SITE_ORIGIN } from '../forum/view.js';
import { getDrepMetadataBodyByHash } from '../db/drepMetadata.js';
import { getVoteRationaleBody } from '../db/voteRationale.js';

export type SelfHostedRef =
  | { kind: 'drep-metadata'; hash: string }
  | { kind: 'vote-rationale'; hash: string }
  | { kind: 'avatar'; hash: string }
  /** On our zone, but not one of the hosted-content paths: nothing to read. */
  | { kind: 'other' };

// One source for "which host is ours": the canonical site origin. The suffix
// match covers every subdomain (preprod.dreptalk.com, www), since same-zone
// loop prevention affects all hosts on the zone.
const ZONE_HOST = new URL(SITE_ORIGIN).hostname;

// Path shapes mirror the serving routes exactly (lowercase 64-hex, like their
// HASH_RE): a URL the route would 404 must resolve the same way here.
const DREP_DOC_RE = new RegExp(`^/drep/(${HEX_64_SOURCE})\\.json$`);
const VOTE_RATIONALE_RE = new RegExp(`^/vote-rationale/(${HEX_64_SOURCE})\\.json$`);
const AVATAR_RE = new RegExp(`^/api/avatar/(${HEX_64_SOURCE})$`);

/**
 * Classifies a URL on our own zone, or returns null for any foreign URL.
 * Matches both http and https (broken plain-http registrations exist on
 * chain). Self-zone URLs that are not a hosted-content path classify as
 * 'other', so callers can fail fast instead of fetching.
 */
export function selfHostedRef(rawUrl: string): SelfHostedRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== ZONE_HOST && !host.endsWith(`.${ZONE_HOST}`)) return null;

  let m = DREP_DOC_RE.exec(url.pathname);
  if (m) return { kind: 'drep-metadata', hash: m[1] };
  m = VOTE_RATIONALE_RE.exec(url.pathname);
  if (m) return { kind: 'vote-rationale', hash: m[1] };
  m = AVATAR_RE.exec(url.pathname);
  if (m) return { kind: 'avatar', hash: m[1] };
  return { kind: 'other' };
}

/**
 * Reads the stored body for a self-hosted document ref from D1, or null when
 * there is nothing to read: row missing (= the serving route's 404), an avatar
 * ref (image bytes, not a JSON document), or an unrecognized self-zone path.
 */
export async function readSelfHostedBody(db: D1Database, ref: SelfHostedRef): Promise<string | null> {
  if (ref.kind === 'drep-metadata') return getDrepMetadataBodyByHash(db, ref.hash);
  if (ref.kind === 'vote-rationale') return getVoteRationaleBody(db, ref.hash);
  return null;
}
