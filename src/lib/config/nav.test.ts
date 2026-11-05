import { describe, expect, it } from 'vitest';
import { isNavGroup, navFor, navLinksFor } from './nav.js';

const dreps = (network: 'mainnet' | 'preprod') => {
  const group = navFor(network).find((e) => isNavGroup(e) && e.label === 'DReps');
  return group && isNavGroup(group) ? group.items.map((l) => l.label) : [];
};

describe('navFor', () => {
  it('lists DRep groups right after the DRep directory where groups run', () => {
    const items = dreps('preprod');
    expect(items.slice(0, 2)).toEqual(['DRep directory', 'DRep groups']);
    expect(navLinksFor('preprod').some((l) => l.href === '/groups/')).toBe(true);
  });

  it('leaves DRep groups out on mainnet', () => {
    expect(dreps('mainnet')).not.toContain('DRep groups');
    expect(navLinksFor('mainnet').some((l) => l.href === '/groups/')).toBe(false);
  });
});
