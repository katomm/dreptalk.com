// Help search runs entirely on the client against a small build-time index of
// the guides collection. Snippets use the same char(1)/char(2) delimiters as
// the D1 snippet() output so parseSnippet renders the highlight identically.
export interface HelpDoc {
  title: string;
  href: string;
  headings: string[];
  text: string;
}

export interface HelpHit {
  title: string;
  href: string;
  snippet: string | null;
  score: number;
}

const OPEN = String.fromCharCode(1);
const CLOSE = String.fromCharCode(2);

/** Strips markdown to plain text: drops code, turns links into their text,
 *  removes heading/emphasis/list markers, collapses whitespace. */
export function flattenMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links to their text
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/[*_>#-]/g, ' ') // emphasis, list, quote marks
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pulls ATX heading texts (# .. ######) in document order. */
export function extractHeadings(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split('\n')) {
    const m = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function tokenize(s: string): string[] {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[a-z0-9]+/g) ?? []
  );
}

function snippetAround(text: string, token: string): string | null {
  const lower = text.toLowerCase();
  const i = lower.indexOf(token);
  if (i < 0) return null;
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + token.length + 40);
  const pre = (start > 0 ? '…' : '') + text.slice(start, i);
  const hit = text.slice(i, i + token.length);
  const post = text.slice(i + token.length, end) + (end < text.length ? '…' : '');
  return `${pre}${OPEN}${hit}${CLOSE}${post}`;
}

/** Scores docs by token hits (title 5, heading 3, body 1) and returns the top
 *  matches with a body snippet around the first matched token. */
export function searchHelp(docs: HelpDoc[], q: string, limit = 20): HelpHit[] {
  const tokens = tokenize(q);
  if (tokens.length === 0) return [];
  const hits: HelpHit[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const headings = doc.headings.join(' ').toLowerCase();
    const body = doc.text.toLowerCase();
    let score = 0;
    let snippet: string | null = null;
    for (const tok of tokens) {
      if (title.includes(tok)) score += 5;
      if (headings.includes(tok)) score += 3;
      if (body.includes(tok)) {
        score += 1;
        if (!snippet) snippet = snippetAround(doc.text, tok);
      }
    }
    if (score > 0) hits.push({ title: doc.title, href: doc.href, snippet, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
