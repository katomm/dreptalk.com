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
    addresses: [
      'stake1uyvjdz9rxsfsmv44rtk75k2rqyqskrga96dgdfrqjvjjpwsefcjnp',
      // Earlier submitter address (Plomin hard fork, Constitution, Plutus cost
      // model); metadata hosted under github.com/IntersectMBO/governance-actions.
      'stake1uyguuqwdpexmhgjd07vax5t2ay3f7qvea49ex907g6fmvjclq6l03',
      // Joint MBO budgets administered by Intersect (Critical Integrations, TOKEN2049).
      'stake1uxq8hyxek4nvl227wjvrdm0h000sjgraczp92c07l0wr56g05k4la',
    ],
    icon: '/orgs/intersect.png',
    website: 'https://www.intersectmbo.org',
  },
  {
    slug: 'input-output',
    name: 'Input Output',
    addresses: ['stake1uy7ucfwsxtv36lz2drg4nw538xswshmg9pw8h2yzqd4qrzgzhyrsg'],
    icon: '/orgs/inputoutput.jpg',
    website: 'https://iohk.io',
  },
  {
    slug: 'snek-foundation',
    name: 'Snek Foundation',
    addresses: ['stake1uy5wxkqpezym2esqkgvw9yyqyd0rzuhkm206q6cddcxtqjgehj9ty'],
    icon: '/orgs/snek.jpg',
  },
  {
    slug: 'harmonic-labs',
    name: 'Harmonic Labs',
    addresses: ['stake1u949rs3erz72xxsj6uye2k0whkcv909043ld6dnv504eqwc4a60sc'],
    icon: '/orgs/harmoniclabs.jpg',
  },
  {
    slug: 'pragma',
    name: 'PRAGMA',
    addresses: [
      'stake179vw36vvvkmq32dfa002gtc8mk6v4zv2a74ppaxsz3dejhs72dh4z',
      'stake17yyule028w4c2xy2rzsnzs22v4cvav3aljm5z76kz9hc9as0vfqh9',
    ],
    icon: '/orgs/pragma.jpg',
  },
  {
    slug: 'cardano-foundation',
    name: 'Cardano Foundation',
    addresses: ['stake1uyyqmz5ae7ct4f26p4t87y2xrrgu7f3e0cpap66zgcnxu0gl7gy6y'],
    website: 'https://cardanofoundation.org',
  },
  {
    slug: 'eternl',
    name: 'Eternl',
    addresses: ['stake1ux0uusq33auzyekl6x566a886ltgzw0n6l2nl9yv2fpe74gt48ert'],
    website: 'https://eternl.io',
  },
  {
    slug: 'blink-labs',
    name: 'Blink Labs',
    addresses: ['stake1u8j3j3rjw5tjgyh6w4ezx0z4lglu3ufxsfuev4ndchld6jsdlaaqg'],
    website: 'https://blinklabs.io',
  },
  {
    slug: 'deltadefi',
    name: 'DeltaDeFi',
    addresses: ['stake1u98py2aurukenuwgt78znz7jr90j3jkwfxeh2t7zlge6z8clpduxn'],
    website: 'https://deltadefi.io',
  },
  {
    slug: 'scalus',
    name: 'Scalus',
    addresses: ['stake1uxlvah74gljhkhehgh5u5dywmuljtm2v068nh7prgpp4uxcf5r9dg'],
  },
  {
    slug: '5am-earth',
    name: '5am.earth',
    addresses: ['stake1uxx5zvsjds4mha66z6y0ftd40ztzt7f90eqlf85hmvhlukc6p4ue3'],
    website: 'https://5am.earth',
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
