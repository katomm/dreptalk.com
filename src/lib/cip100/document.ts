// Builds the immutable CIP-100 document for one post version.
//
// The function is pure and contains NO emit-time value: every field comes from
// the post, its thread or its chain position, and the timestamps are the post's
// own. Two callers building the same logical version therefore produce
// byte-identical output and the same hash, which is what lets the request path
// and the cron race safely and what makes the fixed-vector test possible.
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { CIP100_INLINE_CONTEXT, EXTENSION_CONTEXT_URL } from './context.js';
import { postVersionsUrl, snapshotUrl, threadManifestUrl, type Cip100Network } from './origin.js';

const TEXT_ENCODER = new TextEncoder();

export interface Cip100PostedBy {
  handle: string;
  /** Profile page, only for authors that have one (DReps and SPOs). */
  profile: string | null;
  drepId: string | null;
  poolId: string | null;
}

export interface DiscussionPostDocInput {
  origin: string;
  network: Cip100Network;
  postId: string;
  topicId: string;
  topicSlug: string;
  version: number;
  postedAt: number;
  revisedAt: number | null;
  governanceActionId: string | null;
  parentPostId: string | null;
  /** The parent's head snapshot at the time the reply was written, when known.
   *  Backfilled documents leave this null rather than pointing at today's head,
   *  which would claim a historical fact that is not true. */
  parentDocHash: string | null;
  prevHash: string | null;
  postedBy: Cip100PostedBy;
  comment: string;
}

export interface BuiltCip100Doc {
  body: string;
  hash: string;
}

/** ISO 8601 UTC at second precision, the format the spec pins for every
 *  timestamp in an emitted document. */
export function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

export function buildDiscussionPostDoc(input: DiscussionPostDocInput): BuiltCip100Doc {
  const { origin } = input;
  const snapshot = (hash: string) => snapshotUrl(origin, hash);
  const threadUrl = `${origin}/t/${input.topicSlug}/`;
  const permalink = `${threadUrl}#post-${input.postId}`;

  // references repeat the extension terms in human form, so a reader that only
  // knows CIP-100 still gets working links. The duplication is the graceful
  // degradation path, not an oversight.
  const references: Array<{ '@type': string; label: string; uri: string }> = [
    { '@type': 'Other', label: 'Post permalink', uri: permalink },
    { '@type': 'Other', label: 'Discussion', uri: threadUrl },
  ];
  if (input.governanceActionId) {
    references.push({ '@type': 'Other', label: 'Governance action', uri: `${origin}/ga/${input.governanceActionId}` });
  }
  if (input.prevHash) {
    references.push({ '@type': 'Other', label: 'Previous version', uri: snapshot(input.prevHash) });
  }
  if (input.parentDocHash) {
    references.push({ '@type': 'Other', label: 'In reply to', uri: snapshot(input.parentDocHash) });
  }

  // Author identity is a claim by the publisher, never cryptographic
  // authorship, which is why it lives here and never in `authors`.
  const postedBy: Record<string, string> = { handle: input.postedBy.handle };
  if (input.postedBy.profile) postedBy.profile = input.postedBy.profile;
  if (input.postedBy.drepId) postedBy.drepId = input.postedBy.drepId;
  if (input.postedBy.poolId) postedBy.poolId = input.postedBy.poolId;

  // Key order is the serialization contract. Assign in exactly this order and
  // never reorder without treating it as a format change.
  const body: Record<string, unknown> = {
    postId: input.postId,
    version: input.version,
    postedAt: isoSeconds(input.postedAt),
  };
  if (input.revisedAt !== null) body.revisedAt = isoSeconds(input.revisedAt);
  body.network = input.network;
  body.forum = `${origin}/`;
  body.thread = threadManifestUrl(origin, input.topicId);
  if (input.governanceActionId) body.governanceActionId = input.governanceActionId;
  if (input.parentPostId) body.inReplyToPostId = input.parentPostId;
  if (input.parentDocHash) body.inReplyTo = snapshot(input.parentDocHash);
  if (input.prevHash) body.revisionOf = snapshot(input.prevHash);
  body.postedBy = postedBy;
  body.comment = input.comment;
  body.externalUpdates = [
    { title: 'Versions of this post', uri: postVersionsUrl(origin, input.postId) },
  ];
  body.references = references;

  // `@type` sits at the document level, not inside `body`, so a consumer that
  // filters governance metadata by document type sees the post. That is where
  // the version index and the thread manifest carry theirs too, and where the
  // CIP-100 extensions currently in review put it.
  const doc = {
    '@context': [CIP100_INLINE_CONTEXT, EXTENSION_CONTEXT_URL],
    '@type': 'DiscussionPost',
    hashAlgorithm: 'blake2b-256',
    authors: [] as unknown[],
    body,
  };

  // Two-space indentation and a trailing newline, so a cited document is
  // readable by the human who follows the link. The hash is over exactly these
  // bytes, with no canonicalization step anywhere.
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  return { body: serialized, hash: bytesToHex(blake2b256(TEXT_ENCODER.encode(serialized))) };
}
