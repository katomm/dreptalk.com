// Curated registry of well-known governance proposers, keyed by their on-chain
// reward (return) address. One org can rotate addresses, so addresses is a list.
// Entries are user-confirmed from a one-time history analysis; the list may be
// small at first and grow. Mirrors config/categories.ts.

export interface Proposer {
  slug: string;        // stable key, e.g. 'intersect'
  name: string;        // display name
  addresses: string[]; // one or more return_address (stake1...) values
  icon?: string;       // bundled logo path, e.g. '/orgs/intersect.svg'; absent -> identicon
  website?: string;    // optional https link
}

// Filled from the confirmed history analysis later. Safe to ship small/empty:
// unmatched proposers fall back to an identicon + their address.
export const PROPOSERS: Proposer[] = [];

/** Lowercase + trim, so lookups are case/whitespace-insensitive. */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Builds an address -> Proposer map (every address of every org). Pure. */
export function buildProposerIndex(list: Proposer[]): Map<string, Proposer> {
  const index = new Map<string, Proposer>();
  for (const proposer of list) {
    for (const address of proposer.addresses) {
      index.set(normalizeAddress(address), proposer);
    }
  }
  return index;
}

// Built once at module load (O(1) lookups, no per-render scan).
const INDEX = buildProposerIndex(PROPOSERS);

/** Resolves a return_address to its known org, or null. */
export function getProposerByAddress(returnAddress: string | null | undefined): Proposer | null {
  if (!returnAddress) return null;
  return INDEX.get(normalizeAddress(returnAddress)) ?? null;
}

/** The full curated list (for any future directory; read-only). */
export function getProposers(): readonly Proposer[] {
  return PROPOSERS;
}
