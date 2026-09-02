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
  // Lands on the Discussion tab (human forum activity); the page itself defaults
  // to the "All" feed, which the homepage's "View all activity" link points to.
  { label: 'Discussions', href: '/discussions/?filter=comments' },
  { label: 'DReps', href: '/dreps/' },
  { label: 'Treasury', href: '/c/budget/' },
  { label: 'Analytics', href: '/analytics/' },
];
