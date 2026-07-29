import { describe, it, expect } from 'vitest';
import { delegationLabel } from './format.js';

describe('delegationLabel', () => {
  it('labels the auto options and none without a name', () => {
    expect(delegationLabel({ type: 'abstain' })).toBe('Always Abstain');
    expect(delegationLabel({ type: 'no_confidence' })).toBe('Always No Confidence');
    expect(delegationLabel({ type: 'none' })).toBe('no DRep');
  });
  it('prefers a resolved DRep name, else a shortened drep id', () => {
    expect(delegationLabel({ type: 'drep', drepId: 'drep1abcdefghijklmnop' }, 'Alice')).toBe('Alice');
    expect(delegationLabel({ type: 'drep', drepId: 'drep1abcdefghijklmnop' })).toMatch(/^drep1/);
  });
});
