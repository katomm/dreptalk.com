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
//   1. This module NEVER enumerates the account. There is no list call, and
//      adding one is a design break, not an optimisation. It only ever acts on
//      file ids the app recorded itself in gov_action_metadata.
//   2. Before each delete it READS the file by id and refuses unless the file
//      sits in our own Pinata group. That is the real ownership test, because
//      unlike (1) it does not depend on our own bookkeeping being correct: an
//      id that reached the table by any route, including a compromised writer,
//      still fails it.
//
// A scoped Pinata API key is NOT a third property. A key restricts permissions,
// not which files those permissions reach, so a key holding org:files:write can
// delete anything on the account. Never present the key split as a safeguard.

import {
  getCollectablePins,
  countCollectablePins,
  markPinDeleting,
  releasePinDeleting,
  disownPin,
  deleteGovActionMetadata,
} from '../db/govActionMetadata.js';

const PINATA_API = 'https://api.pinata.cloud/v3/files/public';

/** Seven days. Long enough that a slow proposer never loses a document they are still about to anchor. */
export const PIN_GRACE_SECONDS = 7 * 24 * 60 * 60;
/** After this many failed deletes a row is left alone for a human to look at. */
export const PIN_MAX_DELETE_ATTEMPTS = 5;

/**
 * The two Pinata calls this module makes, injectable so tests never touch the
 * network. There is deliberately no list operation: see the header.
 */
export interface PinataFileClient {
  /** Reads one file by id. Returns null when Pinata says it is gone. */
  read(fileId: string): Promise<{ groupId: string | null } | null>;
  /** Deletes one file by id. Resolves for an already-absent file. */
  remove(fileId: string): Promise<void>;
}

/** Talks to the real Pinata v3 API. Needs org:files:read and org:files:write. */
export function makePinataFileClient(jwt: string): PinataFileClient {
  const headers = { authorization: `Bearer ${jwt}` };
  return {
    async read(fileId) {
      const resp = await fetch(`${PINATA_API}/${encodeURIComponent(fileId)}`, { headers });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`pinata read failed: ${resp.status}`);
      const json = (await resp.json()) as { data?: { group_id?: string | null } };
      return { groupId: json.data?.group_id ?? null };
    },
    async remove(fileId) {
      const resp = await fetch(`${PINATA_API}/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers });
      // Already gone is the goal state, not a failure.
      if (resp.status === 404) return;
      if (!resp.ok) throw new Error(`pinata delete failed: ${resp.status}`);
    },
  };
}

export interface CollectPinsInput {
  db: D1Database;
  client: PinataFileClient;
  /** Our Pinata group. Without it the collector refuses to run at all. */
  groupId: string;
  /** Unix seconds. */
  now: number;
  limit: number;
  graceSeconds?: number;
  maxAttempts?: number;
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
  const graceSeconds = input.graceSeconds ?? PIN_GRACE_SECONDS;
  const maxAttempts = input.maxAttempts ?? PIN_MAX_DELETE_ATTEMPTS;
  const graceCutoff = input.now - graceSeconds;

  const candidates = await getCollectablePins(input.db, { graceCutoff, maxAttempts, limit: input.limit });
  let deleted = 0;
  let failed = 0;
  let foreign = 0;

  for (const pin of candidates) {
    // Claim it first: two overlapping ticks must not both delete one file, and
    // a claimed row stops being served to a resubmission mid-delete.
    if (!(await markPinDeleting(input.db, pin.hash, input.now))) continue;
    try {
      const file = await input.client.read(pin.pinataFileId);
      if (file && file.groupId !== input.groupId) {
        // Not ours. Never delete it, and never look at it again: a file outside
        // our group cannot become ours, so retrying would only repeat this alarm
        // until the attempt budget runs out. Forget the id instead. The row and
        // its CID stay, so the document is still served.
        foreign++;
        console.error(
          `[pin-gc] REFUSING to delete ${pin.pinataFileId}: group ${file.groupId ?? 'none'} is not ours`,
        );
        await disownPin(input.db, pin.hash);
        continue;
      }
      // A file Pinata no longer has (read returned null) still needs its row
      // cleared, otherwise it is reconsidered every run forever.
      if (file) await input.client.remove(pin.pinataFileId);
      await deleteGovActionMetadata(input.db, pin.hash);
      deleted++;
    } catch (err: unknown) {
      failed++;
      console.error(`[pin-gc] delete failed for ${pin.hash}`, err);
      await releasePinDeleting(input.db, pin.hash);
    }
  }

  const backlog = await countCollectablePins(input.db, { graceCutoff, maxAttempts });
  return { scanned: candidates.length, deleted, failed, foreign, backlog };
}
