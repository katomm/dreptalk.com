import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DrepShareKit from './DrepShareKit.tsx';

describe('DrepShareKit', () => {
  it('is a collapsed section that points every snippet at the handle', () => {
    const html = renderToStaticMarkup(<DrepShareKit handle="adatainment" name="ADAtainment" />);
    expect(html).toMatch(/^<details class="kit"/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('Share your votes');
    expect(html.match(/href=&quot;https:\/\/drep\.link\/adatainment&quot;/g)).toHaveLength(3);
    expect(html).toContain('data-copy-label="Copy text"');
  });

  it('says where to get a link when there is no handle yet', () => {
    const html = renderToStaticMarkup(<DrepShareKit handle={null} name="X" />);
    expect(html).toContain('Once you have a drep.link above');
    expect(html).not.toContain('embed__copy');
  });

  it('follows a new handle on re-render', () => {
    const before = renderToStaticMarkup(<DrepShareKit handle="old-name" name={null} />);
    const after = renderToStaticMarkup(<DrepShareKit handle="new-name" name={null} />);
    expect(before).toContain('drep.link/old-name');
    expect(after).toContain('drep.link/new-name');
    expect(after).not.toContain('old-name');
  });
});
