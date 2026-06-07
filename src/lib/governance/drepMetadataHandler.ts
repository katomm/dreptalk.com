/// <reference types="@cloudflare/workers-types" />
// Proof-of-control handler for hosting CIP-119 DRep metadata.
//
// Hosting is unauthenticated by nature (a DRep hosts its metadata BEFORE the
// on-chain registration that references it, so there is no session yet). To stop
// anyone from writing or overwriting metadata for an arbitrary drep id, the
// submitter must prove control of the DRep key: they sign a fresh challenge with
// the DRep key (CIP-8, the same signature the login flow uses), and we require
// the drep id derived from that key to equal the submitted one. Storage of junk
// rows for self-generated keys is bounded separately by the sync GC.

import { z } from 'zod';
import { verifyCip8 } from '../auth/cose.js';
import { consumeNonce as defaultConsumeNonce } from '../auth/nonce.js';
import { drepIdFromPubKey, DREP_KEY_HEADER } from '../cardano/identity.js';
import { isHex, MAX_PAYLOAD_LEN, MAX_KEY_HEX_LEN, MAX_SIG_HEX_LEN } from '../validation/input.js';
import { buildDrepMetadata } from './drepMetadata.js';
import { putDrepMetadata } from '../db/drepMetadata.js';

// CIP-129 DRep id: bech32 with "drep1" prefix.
const DREP_ID_RE = /^drep1[0-9a-z]{10,120}$/;

const bodySchema = z.object({
  drepId: z.string().regex(DREP_ID_RE, 'invalid drep id'),
  name: z.string(),
  bio: z.string(),
  links: z.array(z.string()).max(20),
  payload: z.string(),
  signatureHex: z.string(),
  keyHex: z.string(),
});

export interface DrepMetadataInput {
  body: unknown;
  nonceKv: KVNamespace;
  db: D1Database;
  origin: string;
  now: number; // milliseconds
}

export interface DrepMetadataDeps {
  consumeNonce?: (kv: KVNamespace, payload: string, opts?: { now?: number }) => Promise<boolean>;
}

export interface DrepMetadataResult {
  status: number;
  json: unknown;
}

/** Never throws; unexpected errors become a generic 500. */
export async function handleDrepMetadata(
  input: DrepMetadataInput,
  deps?: DrepMetadataDeps,
): Promise<DrepMetadataResult> {
  try {
    return await handleInternal(input, deps);
  } catch {
    return { status: 500, json: { error: 'internal error' } };
  }
}

async function handleInternal(input: DrepMetadataInput, deps?: DrepMetadataDeps): Promise<DrepMetadataResult> {
  const consume = deps?.consumeNonce ?? defaultConsumeNonce;

  const parsed = bodySchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, json: { error: parsed.error.issues[0]?.message ?? 'invalid input' } };
  }
  const { drepId, name, bio, links, payload, signatureHex, keyHex } = parsed.data;

  // Bound the untrusted hex/payload fields before any decode or crypto.
  if (
    payload.length > MAX_PAYLOAD_LEN ||
    !isHex(keyHex, MAX_KEY_HEX_LEN) ||
    !isHex(signatureHex, MAX_SIG_HEX_LEN)
  ) {
    return { status: 400, json: { error: 'invalid input' } };
  }

  // Consume the single-use challenge (seconds for the age check).
  const nonceOk = await consume(input.nonceKv, payload, { now: Math.floor(input.now / 1000) });
  if (!nonceOk) {
    return { status: 401, json: { error: 'invalid or expired challenge' } };
  }

  // Verify the CIP-8 signature and require a DRep key-hash credential.
  const verified = await verifyCip8({ signatureHex, keyHex, expectedPayload: payload });
  if (!verified.ok || !verified.pubKey || !verified.addressBytes) {
    return { status: 401, json: { error: 'signature verification failed' } };
  }
  if (verified.addressBytes.length === 0 || verified.addressBytes[0] !== DREP_KEY_HEADER) {
    return { status: 401, json: { error: 'not a DRep key signature' } };
  }

  // Proof of control: the drep id derived from the verified key must match the
  // submitted one. Use the derived id for storage and the URL (never trust the
  // client's claim).
  const derivedDrepId = drepIdFromPubKey(verified.pubKey);
  if (derivedDrepId !== drepId) {
    return { status: 403, json: { error: 'key does not control this drep id' } };
  }

  const m = buildDrepMetadata({ name, bio, links });
  const url = `${input.origin}/drep/${derivedDrepId}/metadata.json`;
  await putDrepMetadata(input.db, {
    drepId: derivedDrepId,
    body: m.body,
    hash: m.hash,
    name: m.name,
    createdAt: Math.floor(input.now / 1000),
  });

  return { status: 200, json: { url, hash: m.hash } };
}
