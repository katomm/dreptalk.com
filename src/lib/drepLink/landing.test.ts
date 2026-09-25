import { describe, it, expect } from 'vitest';
import { renderLanding } from './landing.js';

describe('renderLanding', () => {
  const html = renderLanding({ siteOrigin: 'https://dreptalk.com', linkOrigin: 'https://drep.link', example: 'some-drep' });
  it('is a complete page with canonical, OG tags and the lookup form', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<link rel="canonical" href="https://drep.link/">');
    expect(html).toContain('<meta property="og:image" content="https://dreptalk.com/og/drep-link.png?v=1">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta name="twitter:image" content="https://dreptalk.com/og/drep-link.png?v=1">');
    expect(html).toContain('<form action="/" method="get"');
    expect(html).toContain('name="h"');
    expect(html).toContain('href="https://dreptalk.com/settings/profile/"');
  });
  it('shows the given handle as the example', () => {
    expect(html).toContain('<a href="/some-drep"><code>drep.link/some-drep</code></a>');
  });
  it('makes clear that the link is free', () => {
    expect(html).toContain('Every DRep gets a free short link');
    expect(html).toContain('Get your free drep.link');
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
