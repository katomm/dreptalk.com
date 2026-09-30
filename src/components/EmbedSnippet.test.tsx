// Server render assertion, no testing-library in this repo (same approach as
// NotificationSettings.test.tsx).
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbedSnippet from './EmbedSnippet.tsx';

describe('EmbedSnippet', () => {
  it('renders the copy button the brand copy script listens for', () => {
    const html = renderToStaticMarkup(<EmbedSnippet title="Banner" note="A note." html={'<a href="x">y</a>'} />);
    expect(html).toContain('class="btn btn-secondary embed__copy"');
    expect(html).toContain('data-copy="&lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;"');
    expect(html).toContain('data-copy-label="Copy HTML"');
    expect(html).toContain('<div class="embed__preview"><a href="x">y</a></div>');
  });

  it('shows a plain text snippet as text, with its own copy label', () => {
    const html = renderToStaticMarkup(
      <EmbedSnippet title="Share text" note="For your bios." html="See how I vote: https://drep.link/x" copyLabel="Copy text" preview="text" />,
    );
    expect(html).toContain('data-copy-label="Copy text"');
    expect(html).toContain('See how I vote: https://drep.link/x');
  });

  it('never renders a text snippet as markup', () => {
    const html = renderToStaticMarkup(<EmbedSnippet title="t" note="n" html="<b>x</b>" preview="text" />);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
