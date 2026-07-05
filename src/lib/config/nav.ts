// Primary navigation, shared by the site header (Layout.astro) and the
// search palette so the two can never drift.
export interface NavLink {
  label: string;
  href: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { label: 'Governance Actions', href: '/c/governance-actions' },
  { label: 'Discussions', href: '/discussions' },
  { label: 'DReps', href: '/dreps' },
  { label: 'Treasury', href: '/treasury' },
];
