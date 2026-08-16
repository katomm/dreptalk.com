// /.well-known/cip-100.json: the file that makes an external tool realise there
// is anything here to look for. Prose plus URL templates, not a document
// listing. The loudest external feedback so far was "prepare API
// documentation", so discoverability is the adoption blocker, not the format.
import { EXTENSION_CONTEXT_URL } from './context.js';
import { postVersionsUrl, snapshotUrl, threadManifestUrl, type Cip100Network } from './origin.js';

export function buildServiceDescription(origin: string, network: Cip100Network): string {
  const doc = {
    service: 'DRepTalk',
    network,
    site: `${origin}/`,
    description:
      'Public governance discussion. User-authored posts are published as immutable CIP-100 documents so they can be cited and verified. Not all of them are, so a post without a document is normal and not an error.',
    context: EXTENSION_CONTEXT_URL,
    hashAlgorithm: 'blake2b-256',
    urlTemplates: {
      // Built by the same functions that build real addresses, with the
      // placeholder standing in for the id. What we advertise here therefore
      // cannot drift from what we actually serve.
      snapshot: snapshotUrl(origin, '{hash}'),
      postVersions: postVersionsUrl(origin, '{postId}'),
      thread: threadManifestUrl(origin, '{topicId}'),
      governanceActionRedirect: `${origin}/ga/{governanceActionId}`,
    },
    sitemap: `${origin}/sitemap-cip100.xml`,
    // Every document carries its type at the top level, so a consumer can route
    // on it without inspecting the body first.
    documentTypes: {
      snapshot: 'DiscussionPost',
      postVersions: 'DiscussionPostVersions',
      thread: 'DiscussionThread',
    },
    // Only the snapshot is a CIP-100 document. Saying so keeps a consumer from
    // validating the other two against the CIP-100 common schema and reporting
    // our own discovery format as broken.
    documentClasses: {
      snapshot: 'CIP-100 governance metadata (hashAlgorithm, authors, body)',
      postVersions: 'DRepTalk JSON-LD discovery resource, not a CIP-100 document',
      thread: 'DRepTalk JSON-LD discovery resource, not a CIP-100 document',
    },
    verification:
      'Download the snapshot and hash the exact bytes with blake2b-256. No canonicalization is applied or expected.',
    caching:
      'Snapshot bytes never change, but do not cache them as immutable. They carry an ETag of their hash and are cheap to revalidate, and a deleted document has to be able to become 410 for you.',
    authors:
      'Documents carry an empty authors array by design. Author identity is a claim by the publisher, not a cryptographic proof.',
    deletion:
      'Deleted posts return 410 Gone at every snapshot URL. Tombstones stay visible in the post version index and in the thread manifest. If you mirror these documents, poll the manifest and remove content that appears as deleted. A post can also stop being listed in the manifest without a tombstone. Read that disappearance as the same instruction and stop serving that post. A whole thread can go too: when the manifest itself answers 410, stop serving every post it used to list.',
    erasure:
      'A 410 means this origin no longer serves the snapshot and it will not become available again. Erasure is a separate, later step: the forum keeps its own copy of a deleted post for 30 days so that abuse can still be dealt with, then erases the post body, every earlier version of it, its search index entry and these document bytes.',
    documentation: `${origin}/help/citing-a-post/`,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
