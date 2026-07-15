// Client-side helpers shared by the single-vote panel (VotePanel) and the
// batch panel (MultiVoteBar), so the two submit flows cannot drift: rationale
// hosting, the lazy transaction-builder import, the non-fatal vote-record
// POST, and the localStorage draft plumbing.
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';

/**
 * A failure that happened strictly BEFORE the wallet could sign anything
 * (validation, rationale hosting, loading the tx-builder module). Error
 * handlers show these as-is; transaction-level framing (like the batch
 * all-or-nothing note) only applies to failures past this point.
 */
export class PreSignError extends Error {}

/** Hosts a CIP-100 rationale document; returns the content-addressed anchor. */
export async function hostVoteRationale(args: {
  gaId: string;
  drepId: string;
  rationale: string;
}): Promise<{ url: string; hash: string }> {
  const res = await fetchWithTimeout('/api/vote/rationale', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ drepId: args.drepId, gaId: args.gaId, rationale: args.rationale }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new PreSignError(
      body?.error ? `Could not host rationale: ${body.error}.` : 'Could not host the vote rationale. Please try again.',
    );
  }
  return res.json() as Promise<{ url: string; hash: string }>;
}

/**
 * Lazy-loads the heavy transaction-builder module only when the user submits.
 * The import itself can fail on a stale page (after a deploy the old hashed
 * chunk is gone); translate that into a reload hint instead of a cryptic
 * fetch error. Nothing was signed at this point.
 */
export async function loadDrepTxModule(): Promise<typeof import('@/lib/governance/drepTx.js')> {
  try {
    return await import('@/lib/governance/drepTx.js');
  } catch {
    throw new PreSignError(
      'Could not load the transaction builder; this page may be outdated after a site update. Please reload the page and try again. No vote was submitted.',
    );
  }
}

/**
 * Records the optimistic local vote(s) after a successful on-chain submit.
 * Non-fatal by design: the chain is the source of truth and the hourly sync
 * self-heals, so an HTTP failure only warns.
 */
export async function postVoteRecord(body: unknown, logPrefix: string): Promise<void> {
  const res = await fetchWithTimeout('/api/vote/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn(`[${logPrefix}] /api/vote/record failed`, res.status);
  }
}

/** Reads a draft from localStorage; best-effort (null when blocked/absent). */
export function readDraft(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes a draft, or removes it when value is null. Best-effort, never fatal. */
export function writeDraft(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be full or blocked; drafting is best-effort.
  }
}
