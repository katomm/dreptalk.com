// CIP-100 vote rationale builder.
//
// Builds the canonical JSON-LD document (stable key order, UTF-8) and its
// blake2b-256 hash. The hash is embedded on-chain as the vote anchor hash; the
// body is served at the anchor URL. We use the CIP-100 body.comment field, the
// dominant field real-world vote rationales use, which the existing rationale
// display path already renders. CIP-136 structured fields can be added later.
//
// CIP-100: https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md

import { blake2b256 } from '@/lib/crypto/blake.js';
import { bytesToHex } from '@/lib/crypto/hex.js';
import { sanitizeExternalMultiline } from '@/lib/validation/input.js';

const TEXT_ENCODER = new TextEncoder();

// Generous cap on the rationale text. It lives off-chain (the anchor holds only a
// URL plus a 32-byte hash), so length never affects the transaction, and CIP-100
// imposes no cap; this bound is ours, to keep storage, rendering and search sane.
// The client editor, the server validation and the ingest clamp all derive from
// this one constant. The Cardano Foundation voting tool leaves the main rationale
// statement unbounded, so this is set high enough not to clip real-world rationales.
export const MAX_VOTE_RATIONALE = 60000;

export interface VoteRationaleResult {
  rationale: string;
  // Canonical CIP-100 JSON string (stable key order, UTF-8).
  body: string;
  // blake2b-256 of the UTF-8 bytes of `body`, 64 lowercase hex chars.
  hash: string;
}

/**
 * Builds a minimal CIP-100 vote-rationale document and hashes it. Fixed key
 * order makes the bytes (and thus the hash) deterministic, which is required
 * because the hash is the on-chain anchor hash.
 */
export function buildVoteRationale(input: { rationale: string }): VoteRationaleResult {
  const rationale = sanitizeExternalMultiline(input.rationale, MAX_VOTE_RATIONALE);

  const doc = {
    '@context': {
      CIP100: 'https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#',
      hashAlgorithm: 'CIP100:hashAlgorithm',
      body: {
        '@id': 'CIP100:body',
        '@context': {
          comment: 'CIP100:comment',
        },
      },
    },
    hashAlgorithm: 'blake2b-256',
    body: {
      comment: rationale,
    },
  };

  const body = JSON.stringify(doc);
  const hash = bytesToHex(blake2b256(TEXT_ENCODER.encode(body)));
  return { rationale, body, hash };
}
