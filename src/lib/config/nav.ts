// Primary navigation, shared by the site header (Layout.astro) and the
// search palette so the two can never drift.
export interface NavLink {
  label: string;
  /** Compact label the header swaps in where the full one would not fit. */
  shortLabel?: string;
  href: string;
  /** One-line hint shown under the label in a desktop dropdown. */
  hint?: string;
}

/** A header entry that opens a dropdown instead of linking directly. */
export interface NavGroup {
  label: string;
  items: readonly NavLink[];
}

export type NavEntry = NavLink | NavGroup;

export const isNavGroup = (entry: NavEntry): entry is NavGroup => 'items' in entry;

// The two most visited destinations stay one click away. Everything else sits
// in a dropdown with its siblings.
export const NAV: readonly NavEntry[] = [
  { label: 'Governance Actions', shortLabel: 'Actions', href: '/c/governance-actions/' },
  // Opens the Discussion tab (human forum activity). The page itself defaults
  // to the "All" feed, which the homepage's "View all activity" link points to.
  { label: 'Discussions', href: '/discussions/?filter=comments' },
  {
    label: 'DReps',
    items: [
      { label: 'DRep directory', href: '/dreps/', hint: 'Every registered DRep with votes and voting power' },
      { label: 'Find your DRep', href: '/match/', hint: 'Vote on real actions, see whose record matches' },
      { label: 'Movers of the epoch', href: '/dreps/movers/', hint: 'Biggest voting power gains and losses this epoch' },
      { label: 'Badges', href: '/badges/', hint: 'Earned for voting, rationales and discussion' },
      { label: 'Register as a DRep', href: '/register-drep/', hint: 'Register and manage your DRep metadata' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { label: 'Analytics', href: '/analytics/', hint: 'Health and decentralization of governance' },
      { label: 'Governance Review', href: '/governance-review/', hint: 'What happened, edition by edition' },
      { label: 'Treasury', href: '/treasury/', hint: 'How much of the Net Change Limit is used' },
    ],
  },
  {
    label: 'Learn',
    items: [
      { label: 'Help guides', href: '/help/', hint: 'How Cardano governance and DRepTalk work' },
      { label: 'Glossary', href: '/glossary/', hint: 'Governance terms explained' },
    ],
  },
];

/** Every link in the header, dropdown items included, in display order. */
export const NAV_LINKS: readonly NavLink[] = NAV.flatMap((entry) => (isNavGroup(entry) ? entry.items : [entry]));
