/// <reference types="@cloudflare/workers-types" />
// Finalizes a NewConstitution document submission: hashes the exact submitted
// text, pins it to IPFS, and stores an audit row. Mirrors
// infoActionMetadataHandler.ts, with two differences: the constitution body
// is plain markdown text (not a canonicalized CIP-108 JSON document with an
// author witness), and this handler owns the shared gate itself rather than
// leaving it to the route, since the route only delegates.
import type { NetworkConfig } from '@/lib/config/network';
import { jsonResponse } from '@/lib/api/response';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { gateGovActionRequest, GOV_ACTION_RATE_POLICIES } from './govActionGate.js';
import { pinDocument, type FileUploader } from './pinata.js';
import { serveGovActionMetadata, putGovActionMetadata } from '../db/govActionMetadata.js';

/** 256 KiB, measured on the UTF-8 encoded bytes of the submitted text. */
export const CONSTITUTION_DOCUMENT_MAX_BYTES = 256 * 1024;

const TEXT_ENCODER = new TextEncoder();

export interface ConstitutionDocumentDeps {
  network?: NetworkConfig;
  env?: Cloudflare.Env;
  upload?: FileUploader;
  /** Unix milliseconds. Defaults to Date.now(). */
  now?: number;
}

/**
 * Validates, hashes, pins to IPFS, and stores a dedup/audit row for a
 * constitution document. Never throws; unexpected errors become a generic
 * 500.
 *
 * Error-contract ordering: gate -> parse/validate -> D1 lookup by hash (reuse
 * an existing CID without re-uploading) -> pin the exact bytes to Pinata ->
 * insert the audit row only after a successful CID. An anchor is never
 * returned before Pinata confirms a CID (or D1 already has one on record).
 *
 * `bytes` are exactly `new TextEncoder().encode(text)`: no trailing newline,
 * no re-encoding, so the anchor hash matches what a proposer signs off chain
 * against the pinned document byte-for-byte.
 */
export async function handleConstitutionDocument(
  ctx: { request: Request; locals: App.Locals },
  deps?: ConstitutionDocumentDeps,
): Promise<Response> {
  const gate = await gateGovActionRequest(ctx, GOV_ACTION_RATE_POLICIES.document, {
    network: deps?.network,
    env: deps?.env,
  });
  if (gate instanceof Response) return gate;

  try {
    let body: unknown;
    try {
      body = await ctx.request.json();
    } catch {
      return jsonResponse({ error: 'invalid JSON' }, 400);
    }
    if (typeof body !== 'object' || body === null || typeof (body as { text?: unknown }).text !== 'string') {
      return jsonResponse({ error: 'invalid input' }, 400);
    }
    const text = (body as { text: string }).text;
    const bytes = TEXT_ENCODER.encode(text);
    if (bytes.byteLength > CONSTITUTION_DOCUMENT_MAX_BYTES) {
      return jsonResponse({ error: 'document too large' }, 413);
    }

    const hashHex = bytesToHex(blake2b256(bytes));
    const now = deps?.now ?? Date.now();
    const nowSec = Math.floor(now / 1000);

    // Dedup: reuse an existing CID without re-uploading. Serving a row restarts
    // its grace period, so a resubmitted old draft cannot lose the pin it was
    // just handed. A row already claimed for deletion reads as absent and is
    // re-pinned instead, which yields the same CID anyway.
    const existing = await serveGovActionMetadata(gate.db, hashHex, nowSec);
    if (existing) {
      return jsonResponse({ url: `ipfs://${existing.cid}`, hashHex });
    }

    const { cid, fileId } = await pinDocument({
      bytes,
      fileName: `${hashHex}.md`,
      contentType: 'text/markdown',
      // requireJwt: true on the document policy, so jwt is never null here.
      jwt: gate.jwt as string,
      groupId: gate.groupId,
      upload: deps?.upload,
    });
    await putGovActionMetadata(gate.db, {
      hash: hashHex,
      cid,
      body: text,
      createdAt: nowSec,
      pinataFileId: fileId,
      kind: 'constitution',
    });
    return jsonResponse({ url: `ipfs://${cid}`, hashHex });
  } catch (err: unknown) {
    // Several unrelated things can fail here (the Pinata upload, the D1
    // write), and the user is told none of them on purpose. Without this line
    // nobody could tell afterwards which one it was.
    console.error('[gov-action] constitution document: hosting failed', err);
    return jsonResponse({ error: 'internal error' }, 500);
  }
}
