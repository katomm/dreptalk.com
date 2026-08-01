// Builds the exact CIP-108 JSON bytes served/anchored for an InfoAction, plus
// their blake2b-256 anchor hash. Mirrors voteRationale.ts: fixed key order
// makes JSON.stringify deterministic, which is required because the hash is
// the on-chain anchor hash. Reuses the verbatim CIP-108 @context from Task 1
// so the served document is a conformant standalone CIP-108 document.
import { CIP108_CONTEXT, type Cip108Body } from './cip108Canonical.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import {
  INFO_TITLE_MAX,
  INFO_ABSTRACT_MAX,
  INFO_MOTIVATION_MAX,
  INFO_RATIONALE_MAX,
  type Cip108Author,
} from './infoActionLimits.js';

// Field caps and the Cip108Author type live in infoActionLimits.ts (a leaf
// module with no jsonld-tainted imports) so the client island can import them
// without dragging the server-only URDNA2015 canonicalization engine into the
// browser bundle. Re-exported here for backward-compat.
export { INFO_TITLE_MAX, INFO_ABSTRACT_MAX, INFO_MOTIVATION_MAX, INFO_RATIONALE_MAX, type Cip108Author };

const TEXT_ENCODER = new TextEncoder();

/**
 * Builds the served CIP-108 InfoAction metadata document and hashes it.
 * `authors` is embedded verbatim (already assembled, witnesses already
 * verified by the caller); this builder does not verify witnesses.
 */
export function buildInfoActionMetadata(input: { body: Cip108Body; authors: Cip108Author[] }): { body: string; hash: string } {
  // Fixed key order => deterministic bytes => the hash matches the served/pinned file.
  const doc = {
    '@context': CIP108_CONTEXT,
    hashAlgorithm: 'blake2b-256',
    authors: input.authors,
    body: {
      title: input.body.title,
      abstract: input.body.abstract,
      motivation: input.body.motivation,
      rationale: input.body.rationale,
    },
  };
  const body = JSON.stringify(doc);
  const hash = bytesToHex(blake2b256(TEXT_ENCODER.encode(body)));
  return { body, hash };
}
