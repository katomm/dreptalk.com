// Renders /llms.txt: a curated markdown index of the site for language models
// (https://llmstxt.org). The forum itself is dynamic and already covered by the
// sitemaps, so the file lists what a static index can describe: the fixed hub
// pages plus the guides, glossary and Governance Review collections. Pure, no
// Astro imports, so node tests can render it directly.
import { CATEGORY_ORDER, type Category } from '../help/categories.js';
import { GROUP_ORDER, type GlossaryGroup } from '../glossary/groups.js';
import { slugFor } from '../review/windows.js';

export interface LlmsGuide {
  id: string;
  title: string;
  description: string;
  category: Category;
  order: number;
}

export interface LlmsGlossaryEntry {
  id: string;
  term: string;
  description: string;
  group: GlossaryGroup;
  order: number;
}

export interface LlmsEdition {
  edition: number;
  epochFrom: number;
  epochTo: number;
  title: string;
  teaser?: string;
  standfirst: string;
}

export interface LlmsInput {
  guides: readonly LlmsGuide[];
  glossary: readonly LlmsGlossaryEntry[];
  editions: readonly LlmsEdition[];
}

export const SITE_SUMMARY =
  'The public deliberation layer for Cardano governance: discussion, votes, and data on every governance action.';

const HUBS: ReadonlyArray<{ path: string; label: string; note: string }> = [
  { path: '/', label: 'Home', note: 'Latest governance activity, open actions and the analytics strip.' },
  {
    path: '/discussions/',
    label: 'Discussions',
    note: 'Every on-chain governance action has its own thread, plus categories for the constitution, treasury and general debate.',
  },
  {
    path: '/dreps/',
    label: 'DReps',
    note: 'Every Cardano DRep ranked by voting power, with voting record, rationales and delegation history on each profile.',
  },
  {
    path: '/analytics/',
    label: 'Governance analytics',
    note: 'Participation, concentration, committee and SPO turnout, throughput and the default delegation options, per epoch.',
  },
  {
    path: '/governance-review/',
    label: 'Governance Review',
    note: 'Dated reviews of Cardano governance, a few epochs at a time: what was decided, who moved it, what the numbers say.',
  },
  {
    path: '/treasury/',
    label: 'Treasury',
    note: 'How much of the treasury Net Change Limit enacted withdrawals have consumed, and which actions set the limit.',
  },
  {
    path: '/match/',
    label: 'DRep matching',
    note: 'Answer real governance votes and find a DRep whose record matches, then delegate.',
  },
  { path: '/help/', label: 'Help', note: 'Guides on becoming a DRep, delegating, governance actions and how DRepTalk works.' },
  { path: '/glossary/', label: 'Glossary', note: 'Definitions of the core Cardano governance terms.' },
];

// One line per entry: a newline inside a description would start a new list
// item, and a stray "]" would end the link text early.
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const linkText = (s: string) => oneLine(s).replace(/[[\]]/g, '');

const item = (origin: string, path: string, label: string, note: string) =>
  `- [${linkText(label)}](${origin}${path}): ${oneLine(note)}`;

export function renderLlmsText(origin: string, input: LlmsInput): string {
  const out: string[] = [];
  out.push('# DRepTalk', '', `> ${SITE_SUMMARY}`, '');
  out.push(
    'DRepTalk (dreptalk.com) is a forum and data site for Cardano on-chain governance. Every governance action gets a thread where DReps, SPOs and delegators discuss it, and the site tracks votes, rationales, voting power and delegation per epoch. Public pages may be read and cited with a link. The crawl policy in robots.txt applies.',
    '',
  );

  out.push('## Site sections', '');
  for (const h of HUBS) out.push(item(origin, h.path, h.label, h.note));
  out.push('');

  out.push('## Help guides', '');
  for (const category of CATEGORY_ORDER) {
    const inCategory = input.guides
      .filter((g) => g.category === category)
      .sort((a, b) => a.order - b.order);
    if (inCategory.length === 0) continue;
    out.push(`### ${category}`, '');
    for (const g of inCategory) out.push(item(origin, `/help/${g.id}/`, g.title, g.description));
    out.push('');
  }

  out.push('## Governance Review editions', '');
  const editions = [...input.editions].sort((a, b) => b.edition - a.edition);
  for (const e of editions) {
    const path = `/governance-review/${slugFor(e.epochFrom, e.epochTo)}/`;
    const label = `Edition ${e.edition}, epochs ${e.epochFrom} to ${e.epochTo}: ${e.title}`;
    out.push(item(origin, path, label, e.teaser ?? e.standfirst));
  }
  out.push('');

  out.push('## Glossary', '');
  for (const group of GROUP_ORDER) {
    const inGroup = input.glossary.filter((g) => g.group === group).sort((a, b) => a.order - b.order);
    if (inGroup.length === 0) continue;
    out.push(`### ${group}`, '');
    for (const g of inGroup) out.push(item(origin, `/glossary/${g.id}/`, g.term, g.description));
    out.push('');
  }

  out.push('## Optional', '');
  out.push(
    item(origin, '/sitemap.xml', 'Sitemap', 'Every public page, including threads and indexable DRep profiles.'),
    item(
      origin,
      '/sitemap-cip100.xml',
      'CIP-100 sitemap',
      'Machine-readable thread manifests in the CIP-100 governance metadata format.',
    ),
    item(origin, '/register-drep/', 'Register as a DRep', 'Client-side DRep registration and metadata management.'),
    item(origin, '/badges/', 'Badges', 'Achievement badges for governance participation.'),
    item(origin, '/brand/', 'Brand', 'Logos and link badges for referencing DRepTalk.'),
  );
  out.push('');

  return `${out.join('\n')}\n`;
}
