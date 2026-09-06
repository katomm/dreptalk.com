import { describe, it, expect } from 'vitest';
import { govActionHref, govActionIdFromPath } from './links.js';

const HASH = 'a'.repeat(64);

describe('govActionHref', () => {
  it('links the hash-index form via its CIP-129 hex equivalent', () => {
    expect(govActionHref(`${HASH}#0`)).toBe(`/ga/${HASH}00/`);
    expect(govActionHref(`${HASH}#22`)).toBe(`/ga/${HASH}16/`);
  });

  it('never emits an encoded hash mark, which the resolver cannot read', () => {
    expect(govActionHref(`${HASH}#3`)).not.toContain('%23');
  });

  it('passes other id forms through url-encoded', () => {
    expect(govActionHref('gov_action1abc')).toBe('/ga/gov_action1abc/');
  });
});

describe('govActionIdFromPath', () => {
  it('round-trips every govActionHref path back to its id', () => {
    for (const index of [0, 1, 7, 255, 256]) {
      const id = `${HASH}#${index}`;
      const segment = govActionHref(id).split('/')[2];
      expect(govActionIdFromPath(segment)).toBe(id);
    }
  });

  it('rejects a segment that is not a hash plus 1 to 4 hex bytes', () => {
    expect(govActionIdFromPath(HASH)).toBeNull();
    expect(govActionIdFromPath('gov_action1abc')).toBeNull();
    expect(govActionIdFromPath(`${HASH}0`)).toBeNull();
    expect(govActionIdFromPath(`${HASH}#0`)).toBeNull();
  });
});
