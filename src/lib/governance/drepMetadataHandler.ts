/// <reference types="@cloudflare/workers-types" />
// Hosting handler for CIP-119 DRep metadata documents.
//
// Hosting is unauthenticated by design: a DRep hosts its metadata BEFORE the
// on-chain registration that references it, so there is no session and no
// anchor yet. Authenticity is bound on-chain, not here: syncDreps later reads
// the DRep's on-chain anchor { url, dataHash } and only displays a document
// whose blake2b-256 matches dataHash (see lib/governance/metadata.ts). The
// hosting table is just a CDN; it never confers trust.
//
// Storage is content-addressed (drep_id, hash) with INSERT OR IGNORE, so an
// unauthenticated write can neither overwrite a legitimate document nor be used
// to clobber another DRep's served bytes. Junk rows for unanchored ids are
// bounded by the route's per-IP rate limit and the sync GC.

import { z } from 'zod';
import { HEX_HASH_256_RE } from '../crypto/hex.js';
import { buildDrepMetadata } from './drepMetadata.js';
import { putDrepMetadata } from '../db/drepMetadata.js';

// CIP-129 DRep id: bech32 with "drep1" prefix.
const DREP_ID_RE = /^drep1[0-9a-z]{10,120}$/;

// Generous upper bounds purely to reject pathological payloads cheaply; the
// canonical per-field caps are enforced by buildDrepMetadata.
const bodySchema = z.object({
  drepId: z.string().regex(DREP_ID_RE, 'invalid drep id'),
  name: z.string().max(1000),
  bio: z.string().max(20000),
  links: z.array(z.string().max(2100)).max(20),
  image: z
    .object({
      url: z.string().max(2100),
      sha256: z.string().regex(HEX_HASH_256_RE).optional(),
    })
    .optional(),
});

export interface DrepMetadataInput {
  body: unknown;
  db: D1Database;
  origin: string;
  now: number; // milliseconds
}

export interface DrepMetadataResult {
  status: number;
  json: unknown;
}

/** Never throws; unexpected errors become a generic 500. */
export async function handleDrepMetadata(input: DrepMetadataInput): Promise<DrepMetadataResult> {
  try {
    return await handleInternal(input);
  } catch {
    return { status: 500, json: { error: 'internal error' } };
  }
}

async function handleInternal(input: DrepMetadataInput): Promise<DrepMetadataResult> {
  const parsed = bodySchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, json: { error: parsed.error.issues[0]?.message ?? 'invalid input' } };
  }
  const { drepId, name, bio, links, image } = parsed.data;

  const m = buildDrepMetadata({ name, bio, links, image });

  // Content-addressed URL: the hash is in the path, so the bytes served at this
  // URL never change, and a different document gets a different URL. The drep id
  // is deliberately NOT in the path: the on-chain anchor url field is capped at
  // 128 chars (CIP-100), and a drep id (~63) plus a 64-char hash would overflow.
  const url = `${input.origin}/drep/${m.hash}.json`;
  await putDrepMetadata(input.db, {
    drepId,
    body: m.body,
    hash: m.hash,
    name: m.name,
    createdAt: Math.floor(input.now / 1000),
  });

  return { status: 200, json: { url, hash: m.hash } };
}
