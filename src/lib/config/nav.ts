// Primary navigation, shared by the site header (Layout.astro) and the
// search palette so the two can never drift.
export interface NavLink {
  label: string;
  /** Compact label the header swaps in where the full one would not fit. */
  shortLabel?: string;
  href: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { label: 'Governance Actions', shortLabel: 'Actions', href: '/c/governance-actions/' },
  // Opens the Discussion tab (human forum activity). The page itself defaults
  // to the "All" feed, which the homepage's "View all activity" link points to.
  { label: 'Discussions', href: '/discussions/?filter=comments' },
  { label: 'Treasury', href: '/c/budget/' },
  { label: 'DReps', href: '/dreps/' },
  { label: 'Analytics', href: '/analytics/' },
  { label: 'Review', href: '/governance-review/' },
];
