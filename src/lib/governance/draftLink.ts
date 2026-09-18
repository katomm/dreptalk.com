// Reads Proposal Drafts thread links out of an action's CIP-108 references. The
// references are the proposer's free text, so this only recognizes a DRepTalk
// thread URL on the running network's own origin and returns its slug. Whether
// the slug is a live Proposal Drafts thread is the DB's call (resolveDraftTopic).
import type { AnchorReference } from './metadata.js';

const THREAD_PATH = /^\/t\/([^/]+)\/?$/;

/** Thread slugs referenced by the action, in reference order, deduplicated. */
export function draftSlugsFromReferences(refs: readonly AnchorReference[] | null, siteOrigin: string): string[] {
  const slugs: string[] = [];
  for (const r of refs ?? []) {
    let url: URL;
    try {
      url = new URL(r.uri);
    } catch {
      continue;
    }
    if (url.origin !== siteOrigin) continue;
    const m = THREAD_PATH.exec(url.pathname);
    if (m && !slugs.includes(m[1])) slugs.push(m[1]);
  }
  return slugs;
}
