// Help-article index, shared by /help and the search palette (one source, no
// drift). Text doubles as the palette's keyword haystack.
export interface HelpArticle {
  href: string;
  title: string;
  text: string;
}

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    href: '/help/signing-in',
    title: 'Signing in',
    text: 'Who can sign in and with which keys: DReps via their DRep key (CIP-95) and proposers via their reward address. No password, no transaction, no fees.',
  },
  {
    href: '/help/managing-your-drep',
    title: 'Managing your DRep',
    text: 'How to register as a DRep, change your on-chain metadata (name, bio, links, image) from Settings, and deregister to get your 500 ADA deposit back. What costs a deposit, what only costs a fee.',
  },
  {
    href: '/help/data-freshness',
    title: 'Data freshness',
    text: 'How often each on-chain value (governance tallies and status, DRep profiles, vote badges) is refreshed. Cached, not live.',
  },
  {
    href: '/help/governance-statuses',
    title: 'Governance action statuses',
    text: 'What each status label means (active, ratified, enacted, expired, dropped, closed, syncing), grouped by action type.',
  },
  {
    href: '/help/proposers',
    title: 'Proposers',
    text: 'How the proposer of a governance action is identified: a curated list of known organizations shown with their logo, and a deterministic identicon plus address for everyone else.',
  },
  {
    href: '/help/sorting',
    title: 'Sorting governance actions',
    text: 'What the Trending, New, Closing Soon, and Recently Ratified sorts order by, and what Trending pushes to the top.',
  },
  {
    href: '/help/moderation',
    title: 'Moderation',
    text: 'How posts are moderated: community flagging today (3 flags hide a post), with appointed moderators a possibility later.',
  },
  {
    href: '/help/badges',
    title: 'Badges',
    text: 'How achievement badges work: earned automatically from on-chain and forum activity, bronze/silver/gold tiers, permanent, never about the direction of a vote, plus a few hidden ones.',
  },
  {
    href: '/help/open-source',
    title: 'Open source',
    text: 'DRepTalk is open source under the Apache 2.0 license. The full code is on GitHub and contributions are welcome.',
  },
];
