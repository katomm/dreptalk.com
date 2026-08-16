/// <reference types="@cloudflare/workers-types" />
// Fetch + verify + extract a single on-chain vote rationale.
// Most rationales carry the human text in CIP-100 body.comment, but a sizeable
// minority (the Cardano Foundation and other institutional DReps) use the
// CIP-136 structured form instead: summary / rationaleStatement / conclusion,
// with no comment field. We read the comment when present and otherwise compose
// the CIP-136 prose, so neither form renders blank. The doc is untrusted:
// verified by hash in fetchAnchorDoc, then sanitized and rendered here before it
// is ever stored.
import { fetchAnchorDoc, jsonLdValue } from './metadata.js';
import { fetchOrReadAnchorDoc } from './selfHostedDocs.js';
import { sanitizeExternalMultiline } from '../validation/input.js';
import { renderMarkdown } from '../markdown.js';
import { MAX_VOTE_RATIONALE } from './voteRationale.js';

export type VoteRationaleFetch =
  | { status: 'ok'; bodyHtml: string }
  | { status: 'empty' }
  | { status: 'failed' };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * A non-empty trimmed string, or null. Unwraps the JSON-LD expanded value form
 * ({"@value": "..."}) first; rationale documents are CIP-100 JSON-LD, and some
 * real anchors write their prose fields in the expanded form.
 */
function textField(v: unknown): string | null {
  const u = jsonLdValue(v);
  return typeof u === 'string' && u.trim().length > 0 ? u : null;
}

/**
 * Composes the prose of a structured rationale (used when there is no CIP-100
 * comment): summary, then the full rationale statement, then the conclusion, in
 * reading order. Returns null when none are present. Self-authored documents in
 * the wild carry the statement in a plain `rationale` field (CIP-108's name for
 * it) instead of CIP-136's `rationaleStatement`, so that slot falls back to it.
 */
function composeCip136(body: Record<string, unknown>): string | null {
  const statement = textField(body.rationaleStatement) ?? textField(body.rationale);
  const parts = [textField(body.summary), statement, textField(body.conclusion)].filter(
    (s): s is string => s != null,
  );
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * The vote rationale text, sanitized to the canonical cap, or null when the
 * document carries no rendered prose. Prefers the CIP-100 comment; falls back to
 * the CIP-136 structured fields.
 */
export function extractVoteRationaleComment(doc: unknown): string | null {
  const body = asRecord(asRecord(doc).body);
  const raw = textField(body.comment) ?? composeCip136(body);
  if (raw == null) return null;
  const clean = sanitizeExternalMultiline(raw, MAX_VOTE_RATIONALE);
  return clean.length > 0 ? clean : null;
}

/**
 * Fetches and verifies a vote anchor, returning rendered rationale HTML.
 * status 'ok' carries the rendered body. status 'empty' means the document was
 * valid but carried no prose in any known field (nothing to show, do not retry).
 * status 'failed' means fetch or hash verification failed (eligible for an
 * occasional retry).
 */
export async function fetchVoteRationale(
  anchorUrl: string,
  anchorHash: string,
  deps: { db?: D1Database; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<VoteRationaleFetch> {
  // With a db, self-hosted anchor URLs are read from D1 instead of over HTTP
  // (a same-zone fetch would blackhole, see selfHostedDocs.ts).
  const res = deps.db
    ? await fetchOrReadAnchorDoc(deps.db, anchorUrl, anchorHash, deps)
    : await fetchAnchorDoc(anchorUrl, anchorHash, deps);
  if (res.status !== 'ok') return { status: 'failed' };
  const text = extractVoteRationaleComment(res.doc);
  return text ? { status: 'ok', bodyHtml: renderMarkdown(text) } : { status: 'empty' };
}
