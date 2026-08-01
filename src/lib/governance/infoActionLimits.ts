// Leaf module for InfoAction field caps and the author witness shape. Kept
// free of any jsonld-tainted import (no cip108Canonical, no infoActionMetadata)
// so the client island can pull these constants in without dragging the
// server-only URDNA2015 canonicalization engine into the browser bundle.

// Caps on the InfoAction metadata fields. Like MAX_VOTE_RATIONALE in
// voteRationale.ts, these are ours (CIP-108 imposes no cap) and exist to keep
// storage, rendering and search sane; they are enforced by callers, not here.
export const INFO_TITLE_MAX = 80;
export const INFO_ABSTRACT_MAX = 2500;
export const INFO_MOTIVATION_MAX = 20000;
export const INFO_RATIONALE_MAX = 40000;

// Caps on CIP-108 reference links (label + uri). Ours (CIP-108 imposes none),
// enforced by callers. Shared here so the server schema and the client island
// cannot drift out of sync.
export const REFERENCE_LABEL_MAX = 200;
export const REFERENCE_URI_MAX = 2048;
export const REFERENCES_MAX = 10;

export interface Cip108Author {
  name: string;
  witness: { witnessAlgorithm: 'CIP-0008'; publicKey: string; signature: string };
}
