// Links the first mention of each glossary term in a review edition to its
// glossary entry, at build time. The edition files stay untouched, so the fact
// check keeps reading exactly the prose that was written. Headings, existing
// links and code are left alone, and each term links once per edition: one
// link already explains the term, repeated links read as noise.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/**
 * Prose phrases per glossary entry (the slug under src/content/glossary/). A
 * phrase with a capital letter after its first character is an acronym or a
 * name ("DRep", "SPO") and matches in that exact case, every other phrase
 * matches in any case. Longer phrases win over shorter ones at the same spot.
 */
export const GLOSSARY_PHRASES: Record<string, readonly string[]> = {
  abstain: ['always abstain', 'abstain', 'abstained', 'abstaining', 'abstention'],
  'constitutional-committee': ['constitutional committee'],
  delegation: ['delegation'],
  drep: ['DReps', 'DRep'],
  'governance-action': ['governance actions', 'governance action'],
  'hard-fork-initiation': ['hard fork'],
  'info-action': ['info actions', 'info action'],
  // Bare "no confidence" mostly names the predefined delegation option, which
  // this entry explains too, but only in its full name.
  'motion-of-no-confidence': ['motion of no confidence', 'no-confidence motion', 'always no confidence'],
  'new-constitution': ['guardrails script', 'new constitution'],
  proposer: ['proposers', 'proposer'],
  'protocol-parameter-change': ['parameter changes', 'parameter change'],
  spo: ['SPOs', 'SPO', 'pool operators', 'pool operator'],
  'treasury-withdrawal': ['treasury withdrawals', 'treasury withdrawal'],
  'update-constitutional-committee': ['committee update'],
  'vote-rationale': ['rationales', 'rationale'],
  'voting-power': ['voting power'],
};

/** Node types whose text never gets a glossary link. */
const SKIP = new Set(['heading', 'link', 'linkReference', 'code', 'inlineCode', 'html', 'definition', 'image', 'imageReference']);

interface Phrase {
  slug: string;
  text: string;
  caseSensitive: boolean;
}

const PHRASES: Phrase[] = Object.entries(GLOSSARY_PHRASES)
  .flatMap(([slug, texts]) => texts.map((text) => ({ slug, text, caseSensitive: /\p{Lu}/u.test(text.slice(1)) })))
  .sort((a, b) => b.text.length - a.text.length);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word boundaries that also hold next to non-ASCII letters ("DRepTalk" is not "DRep").
const PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${PHRASES.map((p) => escapeRegExp(p.text)).join('|')})(?![\\p{L}\\p{N}])`, 'giu');

function phraseFor(match: string, linked: Set<string>): Phrase | undefined {
  return PHRASES.find((p) => !linked.has(p.slug) && (p.caseSensitive ? match === p.text : match.toLowerCase() === p.text.toLowerCase()));
}

/** Splits one text node into text and link nodes, linking each term not yet
 *  linked in this edition. Returns null when nothing changed. */
function linkText(value: string, linked: Set<string>): MdNode[] | null {
  const out: MdNode[] = [];
  let at = 0;
  for (const m of value.matchAll(PATTERN)) {
    const phrase = phraseFor(m[0], linked);
    if (!phrase) continue;
    linked.add(phrase.slug);
    if (m.index > at) out.push({ type: 'text', value: value.slice(at, m.index) });
    out.push({
      type: 'link',
      url: `/glossary/${phrase.slug}/`,
      data: { hProperties: { className: ['glossary-link'] } },
      children: [{ type: 'text', value: m[0] }],
    });
    at = m.index + m[0].length;
  }
  if (out.length === 0) return null;
  if (at < value.length) out.push({ type: 'text', value: value.slice(at) });
  return out;
}

export function linkGlossaryTerms(tree: MdNode): void {
  const linked = new Set<string>();
  const walk = (node: MdNode) => {
    if (!node.children || SKIP.has(node.type)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value) return linkText(child.value, linked) ?? [child];
      walk(child);
      return [child];
    });
  };
  walk(tree);
}

/** remark plugin wrapper for astro.config.mjs. Runs on review editions only:
 *  guides and glossary entries already link their terms by hand. */
export function remarkGlossaryLinks() {
  return (tree: MdNode, file: { path?: string; history?: string[] }) => {
    const path = file.path ?? file.history?.[0] ?? '';
    if (path.includes('/content/review/')) linkGlossaryTerms(tree);
  };
}
