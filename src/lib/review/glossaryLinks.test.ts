import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { GLOSSARY_PHRASES, remarkGlossaryLinks } from './glossaryLinks.js';

async function render(md: string, path = '/repo/src/content/review/epochs-600-602.md'): Promise<string> {
  const file = await unified().use(remarkParse).use(remarkGfm).use(remarkGlossaryLinks).use(remarkRehype).use(rehypeStringify).process({ value: md, path });
  return String(file);
}

describe('remarkGlossaryLinks', () => {
  it('links the first mention of a term and leaves later ones as text', async () => {
    const html = await render('The DReps voted. Later the DReps voted again.');
    expect(html).toBe('<p>The <a href="/glossary/drep/" class="glossary-link">DReps</a> voted. Later the DReps voted again.</p>');
  });

  it('treats singular and plural as one term', async () => {
    const html = await render('One DRep spoke.\n\nTwo DReps agreed.');
    expect(html.match(/glossary-link/g)).toHaveLength(1);
  });

  it('matches acronyms only in their exact case and on word boundaries', async () => {
    const html = await render('DRepTalk and drep1abc and the spo list, then an SPO.');
    expect(html).toContain('<a href="/glossary/spo/" class="glossary-link">SPO</a>');
    expect(html).not.toContain('/glossary/drep/');
  });

  it('matches plain phrases in any case and prefers the longer phrase', async () => {
    const html = await render('Treasury withdrawals rose, while the Constitutional Committee met.');
    expect(html).toContain('<a href="/glossary/treasury-withdrawal/" class="glossary-link">Treasury withdrawals</a>');
    expect(html).toContain('<a href="/glossary/constitutional-committee/" class="glossary-link">Constitutional Committee</a>');
  });

  it('leaves headings, existing links and code alone', async () => {
    const html = await render('## DReps in charge\n\n[The DRep list](/dreps/) and `DRep` code.\n\nNow a DRep.');
    expect(html).toContain('<h2>DReps in charge</h2>');
    expect(html).toContain('<a href="/dreps/">The DRep list</a>');
    expect(html).toContain('<code>DRep</code>');
    expect(html).toContain('Now a <a href="/glossary/drep/" class="glossary-link">DRep</a>.');
  });

  it('links inside emphasis and table cells', async () => {
    const html = await render('**The hard fork** landed.\n\n| a |\n|---|\n| voting power |');
    expect(html).toContain('<strong>The <a href="/glossary/hard-fork-initiation/" class="glossary-link">hard fork</a></strong>');
    expect(html).toContain('<a href="/glossary/voting-power/" class="glossary-link">voting power</a>');
  });

  it('leaves the bare delegation option "no confidence" unlinked', async () => {
    const html = await render('Stake in no confidence stayed flat. The always no confidence option grew.');
    expect(html).toContain('Stake in no confidence stayed flat.');
    expect(html).toContain('<a href="/glossary/motion-of-no-confidence/" class="glossary-link">always no confidence</a>');
  });

  it('only touches review editions', async () => {
    const html = await render('A DRep.', '/repo/src/content/guides/delegate.md');
    expect(html).toBe('<p>A DRep.</p>');
  });

  it('points every phrase at an existing glossary entry', () => {
    for (const slug of Object.keys(GLOSSARY_PHRASES)) {
      expect(existsSync(`src/content/glossary/${slug}.md`), slug).toBe(true);
    }
  });
});
