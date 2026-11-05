// Primary navigation, shared by the site header (Layout.astro) and the
// search palette so the two can never drift.
import { DREP_GROUPS_NETWORKS } from '../groups/gate.js';
import type { CardanoNetwork } from './network.js';

export interface NavLink {
  label: string;
  /** Compact label the header swaps in where the full one would not fit. */
  shortLabel?: string;
  href: string;
  /** One-line hint shown under the label in a desktop dropdown. */
  hint?: string;
  /** The networks the page exists on, every network when absent. */
  networks?: readonly CardanoNetwork[];
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
      { label: 'DRep groups', href: '/groups/', hint: 'DReps who belong together, recorded on chain', networks: DREP_GROUPS_NETWORKS },
      { label: 'Find your DRep', href: '/match/', hint: 'Vote on past proposals, find DReps who voted like you' },
      { label: 'Movers of the epoch', href: '/dreps/movers/', hint: 'Biggest voting power gains and losses this epoch' },
      { label: 'Badges', href: '/badges/', hint: 'What DReps earn for voting, explaining and discussing' },
      { label: 'Register as a DRep', href: '/register-drep/', hint: 'Become a DRep or edit your DRep profile' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { label: 'Analytics', href: '/analytics/', hint: 'Health and decentralization of governance' },
      { label: 'Governance Review', href: '/governance-review/', hint: 'Regular recap of decisions and numbers' },
      { label: 'Treasury', href: '/treasury/', hint: 'How much can still be withdrawn this period' },
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

const onNetwork = (l: NavLink, network: CardanoNetwork | undefined): boolean => !l.networks || (network !== undefined && l.networks.includes(network));

/** The navigation of a network: links of pages that exist there, and groups that keep a link. */
export function navFor(network: CardanoNetwork | undefined): readonly NavEntry[] {
  return NAV.flatMap((entry): NavEntry[] => {
    if (!isNavGroup(entry)) return onNetwork(entry, network) ? [entry] : [];
    const items = entry.items.filter((l) => onNetwork(l, network));
    return items.length > 0 ? [{ ...entry, items }] : [];
  });
}

/** The links of navFor, dropdown items included, in display order. */
export function navLinksFor(network: CardanoNetwork | undefined): readonly NavLink[] {
  return NAV_LINKS.filter((l) => onNetwork(l, network));
}
