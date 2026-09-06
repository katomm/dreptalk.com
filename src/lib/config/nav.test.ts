import { describe, it, expect } from 'vitest';
import { NAV_LINKS } from './nav.js';

describe('NAV_LINKS', () => {
  it('lists forum categories first, then data pages, then the review', () => {
    expect(NAV_LINKS.map((l) => l.label)).toEqual(['Governance Actions', 'Discussions', 'Treasury', 'DReps', 'Analytics', 'Review']);
    expect(NAV_LINKS.find((l) => l.label === 'Review')?.href).toBe('/governance-review/');
  });
});
