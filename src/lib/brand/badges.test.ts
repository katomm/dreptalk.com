import { describe, it, expect } from 'vitest';
import pinned from './__fixtures__/brandBadges.json';
import { BRAND_BADGES } from './badges.js';

describe('BRAND_BADGES', () => {
  // Partners have pasted these snippets into their sites. Any change here
  // changes what those sites would get on their next copy.
  it('renders the three /brand badges byte for byte as before the refactor', () => {
    expect(BRAND_BADGES.map((b) => b.html)).toEqual(pinned);
  });

  it('keeps footer, sidebar and banner in that order', () => {
    expect(BRAND_BADGES.map((b) => b.kind)).toEqual(['footer', 'sidebar', 'banner']);
  });

  it('writes its notes without semicolons', () => {
    for (const b of BRAND_BADGES) expect(b.note).not.toContain(';');
  });
});
