import { describe, expect, it } from 'vitest';
import { isNavGroup, navFor, navLinksFor } from './nav.js';

describe('navFor', () => {
  it.each(['mainnet', 'preprod'] as const)('links DRep groups on %s', (network) => {
    const hrefs = navFor(network).flatMap((e) => (isNavGroup(e) ? e.items : [e])).map((l) => l.href);
    expect(hrefs).toContain('/groups/');
    expect(navLinksFor(network).some((l) => l.href === '/groups/')).toBe(true);
  });
});
