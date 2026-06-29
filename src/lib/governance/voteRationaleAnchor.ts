/// <reference types="@cloudflare/workers-types" />
// Fetch + verify + extract a single on-chain vote rationale (CIP-100).
// Vote rationales carry the human text in body.comment (the dominant field;
// CIP-136 structured fields are rare). The doc is untrusted: verified by hash in
// fetchAnchorDoc, then sanitized and rendered here before it is ever stored.
import { fetchAnchorDoc } from './metadata.js';
import { sanitizeExternalMultiline } from '../validation/input.js';
import { renderMarkdown } from '../markdown.js';
import { MAX_VOTE_RATIONALE } from './voteRationale.js';

export type VoteRationaleFetch =
  | { status: 'ok'; bodyHtml: string | null }
  | { status: 'failed' };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** The CIP-100 vote rationale text, sanitized to the canonical cap, or null. */
export function extractVoteRationaleComment(doc: unknown): string | null {
  const comment = asRecord(asRecord(doc).body).comment;
  if (typeof comment !== 'string') return null;
  const clean = sanitizeExternalMultiline(comment, MAX_VOTE_RATIONALE);
  return clean.length > 0 ? clean : null;
}

/**
 * Fetches and verifies a vote anchor, returning rendered rationale HTML.
 * status 'ok' with bodyHtml === null means the document was valid but carried
 * no comment (nothing to show, do not retry). status 'failed' means fetch or
 * hash verification failed (eligible for an occasional retry).
 */
export async function fetchVoteRationale(
  anchorUrl: string,
  anchorHash: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<VoteRationaleFetch> {
  const res = await fetchAnchorDoc(anchorUrl, anchorHash, deps);
  if (res.status !== 'ok') return { status: 'failed' };
  const text = extractVoteRationaleComment(res.doc);
  return { status: 'ok', bodyHtml: text ? renderMarkdown(text) : null };
}
