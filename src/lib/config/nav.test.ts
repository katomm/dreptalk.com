import { describe, expect, it } from 'vitest';
import { isNavGroup, navFor, navLinksFor } from './nav.js';

const dreps = (network: 'mainnet' | 'preprod') => {
  const group = navFor(network).find((e) => isNavGroup(e) && e.label === 'DReps');
  return group && isNavGroup(group) ? group.items.map((l) => l.label) : [];
};

describe('navFor', () => {
  it('lists DRep groups right above Register as a DRep where groups run', () => {
    const items = dreps('preprod');
    expect(items.slice(-2)).toEqual(['DRep groups', 'Register as a DRep']);
    expect(navLinksFor('preprod').some((l) => l.href === '/groups/')).toBe(true);
  });

  it('lists DRep groups on mainnet too', () => {
    expect(dreps('mainnet').slice(-2)).toEqual(['DRep groups', 'Register as a DRep']);
    expect(navLinksFor('mainnet').some((l) => l.href === '/groups/')).toBe(true);
  });
});
