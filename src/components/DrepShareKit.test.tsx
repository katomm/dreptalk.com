import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DrepShareKit from './DrepShareKit.tsx';

describe('DrepShareKit', () => {
  it('points every badge at the handle and adds the share text', () => {
    const html = renderToStaticMarkup(<DrepShareKit handle="adatainment" name="ADAtainment" />);
    expect(html.match(/href=&quot;https:\/\/drep\.link\/adatainment&quot;/g)).toHaveLength(3);
    expect(html).toContain('data-copy-label="Copy text"');
  });

  it('offers nothing to copy without a handle', () => {
    const html = renderToStaticMarkup(<DrepShareKit handle={null} name="X" />);
    expect(html).not.toContain('embed__copy');
  });
});
