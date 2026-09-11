/// <reference types="@cloudflare/workers-types" />
// Removes IPFS pins for InfoAction metadata documents that no governance action
// ever anchored: abandoned submissions (the user declined the transaction after
// the document was already published) and anything pinned to abuse the endpoint.
//
// READ THIS BEFORE CHANGING ANYTHING HERE.
//
// The Pinata account is SHARED with another project that stores images on it. A
// collector that reasoned about "everything on the account" would delete those.
// Two independent properties keep that impossible, and both must survive any
// refactor:
//
//   1. Nothing in this app EVER enumerates the account. There is no list call
//      anywhere, and the Pinata module exposes no capability for one, so this
//      collector can only act on file ids the app recorded itself.
//   2. `removeFile` refuses any file outside our own Pinata group, and it makes
//      that check itself rather than trusting a caller to have looked. That is
//      the real ownership test, because unlike (1) it does not depend on our
//      bookkeeping being correct: an id that reached the table by any route,
//      including a compromised writer, still fails it.
//
// The API key is NOT a third property, and the reason is sharper than "scopes
// are coarse": Pinata's Files permission is a single None/Read/Write selector,
// and UPLOADING requires Write. Any token that can pin a document can therefore
// delete any file on the account, which is why the collector simply shares the
// app's token instead of pretending a second one would be weaker. Never present
// a key split as a safeguard here.

import {
  getCollectablePins,
  markPinDeleting,
  releasePinDeleting,
  disownPin,
  deleteGovActionMetadata,
} from '../db/govActionMetadata.js';
import type { PinataFileRemover } from './pinata.js';

/** Seven days. Long enough that a slow proposer never loses a document they are still about to anchor. */
export const PIN_GRACE_SECONDS = 7 * 24 * 60 * 60;
/** A delete claim older than this was left by a run that died; take it back. */
export const PIN_STALE_CLAIM_SECONDS = 60 * 60;

export interface CollectPinsInput {
  db: D1Database;
  remover: PinataFileRemover;
  /** Our Pinata group. Without it the collector refuses to run at all. */
  groupId: string;
  /** Unix seconds. */
  now: number;
  limit: number;
  graceSeconds?: number;
}

export interface CollectPinsResult {
  /** Rows considered this run. */
  scanned: number;
  /** Pins actually removed. */
  deleted: number;
  /** Deletes that failed and will be retried. */
  failed: number;
  /**
   * Files that turned out not to be in our group. Never zero quietly: each one
   * means a foreign id reached our table, which is worth investigating.
   */
  foreign: number;
  /** Collectable rows still waiting after this run. */
  backlog: number;
}

/**
 * Deletes up to `limit` unreferenced pins.
 *
 * The caller is responsible for only invoking this when the governance mirror
 * is healthy: the "is it anchored" test is a join against our own
 * governance_actions table, so a run whose discovery dropped an import would
 * see a freshly anchored document as unreferenced. See the phase wiring.
 *
 * Never throws. A Pinata outage costs a run, not the sync.
 */
export async function collectUnreferencedPins(input: CollectPinsInput): Promise<CollectPinsResult> {
  const graceCutoff = input.now - (input.graceSeconds ?? PIN_GRACE_SECONDS);
  const staleClaimCutoff = input.now - PIN_STALE_CLAIM_SECONDS;

  const { pins, total } = await getCollectablePins(input.db, {
    graceCutoff,
    staleClaimCutoff,
    limit: input.limit,
  });
  let deleted = 0;
  let failed = 0;
  let foreign = 0;

  for (const pin of pins) {
    // Claim it first: two overlapping ticks must not both delete one file, and
    // a claimed row stops being served to a resubmission mid-delete.
    if (!(await markPinDeleting(input.db, pin.hash, input.now, staleClaimCutoff))) continue;
    try {
      const outcome = await input.remover.removeFile(pin.pinataFileId, input.groupId);
      if (outcome === 'not-ours') {
        // Never delete it, and never look at it again: a file outside our group
        // cannot become ours, so retrying would only repeat this alarm. Forget
        // the id instead. The row and its CID stay, so the document is still
        // served.
        foreign++;
        console.error(`[pin-gc] REFUSING to delete ${pin.pinataFileId}: not in our group`);
        await disownPin(input.db, pin.hash);
        continue;
      }
      // 'removed' and 'already-gone' are the same goal state.
      await deleteGovActionMetadata(input.db, pin.hash);
      deleted++;
    } catch (err: unknown) {
      failed++;
      console.error(`[pin-gc] delete failed for ${pin.hash}`, err);
      await releasePinDeleting(input.db, pin.hash);
    }
  }

  return { scanned: pins.length, deleted, failed, foreign, backlog: total - deleted - foreign };
}
