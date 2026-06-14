/// <reference types="@cloudflare/workers-types" />
// Optimistic profile write for the DRep metadata update flow.
//
// A DRep who updates their CIP-119 metadata would otherwise wait for the next
// gov-sync run (about an hour) before the new name, bio, links, and image show
// on their profile. Right after the update_drep tx is submitted, the settings
// island calls this to apply the just-anchored document to the DRep's own row.
//
// Authenticity stays bound on-chain: the values come from the content-addressed
// document the wallet committed (looked up by hash), parsed with the same
// extractCip119Profile the sync uses, so the later sync sees an unchanged row.
// If the tx never confirms, the next sync reads the on-chain anchor and reverts
// the row. Only the logged-in DRep's own row is touched.

import { extractCip119Profile } from './metadata.js';
import { getDrepMetadataByHash } from '../db/drepMetadata.js';
import { updateDrepProfileFromAnchor } from '../db/dreps.js';

export interface ApplyDrepProfileInput {
  db: D1Database;
  /** The logged-in user's drep_id, or null when they are not a DRep. */
  drepId: string | null;
  /** blake2b-256 hex of the hosted CIP-119 document the wallet anchored. */
  hash: string;
  /** Request origin, used to rebuild the anchor URL the wallet committed. */
  origin: string;
  /** Unix milliseconds; stamped as last_synced_at. */
  now: number;
}

export interface ApplyDrepProfileResult {
  status: number;
  json: { ok: boolean; applied: boolean };
}

/** Never throws; unexpected errors become a generic 500. */
export async function applyDrepProfile(input: ApplyDrepProfileInput): Promise<ApplyDrepProfileResult> {
  try {
    return await applyInternal(input);
  } catch {
    return { status: 500, json: { ok: false, applied: false } };
  }
}

async function applyInternal(input: ApplyDrepProfileInput): Promise<ApplyDrepProfileResult> {
  const notApplied = { status: 200, json: { ok: true, applied: false } } as const;

  if (!input.drepId) return notApplied;

  const stored = await getDrepMetadataByHash(input.db, input.hash);
  if (!stored) return notApplied;

  let doc: unknown;
  try {
    doc = JSON.parse(stored.body);
  } catch {
    return notApplied;
  }

  const profile = extractCip119Profile(doc);

  // image_content_hash is only set when the document references an image with a
  // sha256 (our own uploads), since the bytes are then already in R2 and serve
  // immediately. A foreign image without a hash is left for the avatar pass.
  const hasOwnImage = profile.imageUrl != null && profile.imageSha256 != null;

  const applied = await updateDrepProfileFromAnchor(input.db, {
    drepId: input.drepId,
    name: profile.name,
    bio: profile.bio,
    links: profile.links,
    imageUrl: profile.imageUrl,
    imageContentHash: hasOwnImage ? profile.imageSha256 : null,
    imageStoredUrl: hasOwnImage ? profile.imageUrl : null,
    motivations: profile.motivations,
    qualifications: profile.qualifications,
    paymentAddress: profile.paymentAddress,
    doNotList: profile.doNotList,
    anchorUrl: `${input.origin}/drep/${input.hash}.json`,
    anchorHash: input.hash,
    anchorStatus: 'ok',
    lastSyncedAt: input.now,
  });

  return { status: 200, json: { ok: true, applied } };
}
