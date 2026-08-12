// /.well-known/cip-100.json: the file that makes an external tool realise there
// is anything here to look for. Prose plus URL templates, not a document
// listing. The loudest external feedback so far was "prepare API
// documentation", so discoverability is the adoption blocker, not the format.
import { extensionContextUrl } from './context.js';
import type { Cip100Network } from './origin.js';

export function buildServiceDescription(origin: string, network: Cip100Network): string {
  const doc = {
    service: 'DRepTalk',
    network,
    site: `${origin}/`,
    description:
      'Public governance discussion. Every user-authored post is published as an immutable CIP-100 document so it can be cited and verified.',
    context: extensionContextUrl(origin),
    hashAlgorithm: 'blake2b-256',
    urlTemplates: {
      snapshot: `${origin}/cip100/{hash}.json`,
      postVersions: `${origin}/cip100/post/{postId}.json`,
      thread: `${origin}/cip100/topic/{topicId}.json`,
      governanceActionRedirect: `${origin}/ga/{governanceActionId}`,
    },
    sitemap: `${origin}/sitemap-cip100.xml`,
    verification:
      'Download the snapshot and hash the exact bytes with blake2b-256. No canonicalization is applied or expected.',
    caching:
      'Snapshot bytes never change, but do not cache them as immutable. They carry an ETag of their hash and are cheap to revalidate, and a deleted document has to be able to become 410 for you.',
    authors:
      'Documents carry an empty authors array by design. Author identity is a claim by the publisher, not a cryptographic proof.',
    deletion:
      'Deleted posts return 410 Gone at every snapshot URL. Tombstones stay visible in the post version index and in the thread manifest. If you mirror these documents, poll the manifest and remove content that appears as deleted.',
    documentation: `${origin}/help/citing-a-post/`,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
