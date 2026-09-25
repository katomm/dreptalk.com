import { describe, it, expect } from 'vitest';
import { renderLanding } from './landing.js';

describe('renderLanding', () => {
  const html = renderLanding({ siteOrigin: 'https://dreptalk.com', linkOrigin: 'https://drep.link' });
  it('is a complete page with canonical, OG tags and the lookup form', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<link rel="canonical" href="https://drep.link/">');
    expect(html).toContain('<meta property="og:image" content="https://dreptalk.com/og.jpg">');
    expect(html).toContain('<form action="/" method="get"');
    expect(html).toContain('name="h"');
    expect(html).toContain('href="https://dreptalk.com/settings/profile/"');
  });
  it('follows the copy rules', () => {
    expect(html).not.toMatch(/[\u2013\u2014\u2015]|&mdash;|&ndash;/);
    expect(html).not.toMatch(/ADA\b/);
  });
  it('supports dark mode and phone widths', () => {
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('name="viewport"');
  });
});
