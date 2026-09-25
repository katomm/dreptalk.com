import { describe, it, expect } from 'vitest';
import { drepLinkCardHtml } from './templates.js';

describe('drepLinkCardHtml', () => {
  const html = drepLinkCardHtml();
  it('shows the service pill, the headline, the address pattern and that it is free', () => {
    expect(html).toContain('drep.link');
    expect(html).toContain('Short links for Cardano DReps');
    expect(html).toContain('yourname');
    expect(html).toContain('Free for every DRep');
  });
  it('is a 1200 wide card on the shared frame with the bottom accent bar', () => {
    expect(html).toContain('width:1200px');
    expect(html).toContain('height:12px');
  });
  it('follows the copy rules', () => {
    expect(html).not.toMatch(/[–—―]/);
    expect(html).not.toMatch(/\bADA\b/);
  });
});
