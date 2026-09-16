// Why a governance action has no readable body, put into words for the reader.
//
// "No details available" is misleading for almost every such action: most DID
// ship a full CIP-108 document, and what went wrong (nothing attached, anchor
// unreachable, hash drifted, document genuinely empty) is worth naming. The one
// case that used to be missing is the most common one for a brand-new action:
// the anchor simply has not been fetched yet. The metadata backfill retries an
// unreachable anchor up to META_REEXTRACT_MAX_ATTEMPTS times before giving up,
// so meta_attempts tells us whether this is a loading state or a verdict.

import { META_REEXTRACT_MAX_ATTEMPTS } from './metadata.js';

export interface MissingBodyInput {
  anchorUrl: string | null;
  anchorStatus: string;
  metaAttempts: number;
}

export interface MissingBodyState {
  /** True while the backfill is still going to retry this anchor. */
  syncing: boolean;
  message: string;
}

// Statuses that no amount of retrying can change: we either read the document
// (and it was empty, or did not match the on-chain hash) or the anchor names a
// scheme we will never fetch. Everything else, fetch-failed above all, is a
// transport problem that the next backfill run may well get past.
const FINAL_STATUSES = new Set(['ok', 'hash-mismatch', 'unsupported-url']);

/** Explains an action that renders neither an abstract nor a rationale. */
export function describeMissingBody(input: MissingBodyInput): MissingBodyState {
  const { anchorUrl, anchorStatus, metaAttempts } = input;

  if (!anchorUrl) {
    return { syncing: false, message: 'The proposer did not attach a metadata document to this action.' };
  }
  if (anchorStatus === 'ok') {
    return { syncing: false, message: 'The attached metadata document contains no summary or rationale.' };
  }
  if (anchorStatus === 'hash-mismatch') {
    return {
      syncing: false,
      message: 'The metadata document at the anchor no longer matches the on-chain hash, so it cannot be shown here.',
    };
  }
  if (!FINAL_STATUSES.has(anchorStatus) && metaAttempts < META_REEXTRACT_MAX_ATTEMPTS) {
    return {
      syncing: true,
      message: 'The metadata document is still being fetched from its anchor. It appears here as soon as it arrives.',
    };
  }
  // unsupported-url, or a transport failure we have stopped retrying.
  return { syncing: false, message: 'The metadata document could not be retrieved from its anchor.' };
}
