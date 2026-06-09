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

// Seeded from a one-time analysis of mainnet proposal_list (user-confirmed). The
// return_address is largely a shared submitter/administrator address, so we only
// label addresses that map to a single proposing org. The Intersect entry is the
// governance-administration address: Intersect submits and administers many
// actions on behalf of various authors, so it intentionally covers a broad range.
// Unmatched proposers fall back to an identicon + their address. Logos go under
// public/orgs/ (set `icon`); without one, a known org shows an identicon + name.
export const PROPOSERS: Proposer[] = [
  {
    slug: 'intersect',
    name: 'Intersect',
    addresses: ['stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp'],
    website: 'https://www.intersectmbo.org',
  },
  {
    slug: 'input-output',
    name: 'Input Output',
    addresses: ['stake1uy7ucfwsxtv36lz2drg4nw538xswshmg9pw8h2yzqd4qrzgzhyrsg'],
    website: 'https://iohk.io',
  },
  {
    slug: 'snek-foundation',
    name: 'Snek Foundation',
    addresses: ['stake1uy5wxkqpezym2esqkgvw9yyqyd0rzuhkm206q6cddcxtqjgehj9ty'],
  },
  {
    slug: 'hlabs',
    name: 'HLabs',
    addresses: ['stake1u949rs3erz72xxsj6uye2k0whkcv909043ld6dnv504eqwc4a60sc'],
  },
  {
    slug: 'pragma',
    name: 'PRAGMA',
    addresses: [
      'stake179vw36vvvkmq32dfa002gtc8mk6v4zv2a74ppaxsz3dejhs72dh4z',
      'stake17yyule028w4c2xy2rzsnzs22v4cvav3aljm5z76kz9hc9as0vfqh9',
    ],
  },
];

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
