// Emitted documents are absolute-linked, and the base URL is part of the hashed
// bytes. It therefore must come from the deployment, never from a constant, or
// preprod would publish documents claiming mainnet URLs.
import { resolveNetwork } from '../config/network.js';

export type Cip100Network = 'mainnet' | 'preprod';

/** The public origin of this network's site. Read from the one network config
 *  the whole app shares rather than a second copy: a copy can drift, and drift
 *  here bakes wrong URLs into immutable bytes that are already published. */
export function originForNetwork(network: Cip100Network): string {
  return resolveNetwork(network).siteOrigin;
}

/**
 * Profile link for a document author, or null when there is nothing to link.
 * Uses the id form, not the slug form the UI prefers: slugs can be added or
 * changed later, ids cannot, and the id URL always resolves (the profile route
 * 301s to the canonical one). Immutable bytes take the stable form. Authors
 * without a DRep or pool (CC members, delegators) get no profile field at all.
 * Shared by the reconciler and the thread manifest so the two can never
 * disagree about the form of a link.
 */
export function authorProfileUrl(
  origin: string,
  author: { drepId?: string | null; poolId?: string | null },
): string | null {
  if (author.drepId) return `${origin}/dreps/${author.drepId}/`;
  if (author.poolId) return `${origin}/spos/${author.poolId}/`;
  return null;
}
