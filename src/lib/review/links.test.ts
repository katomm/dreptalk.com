import { describe, it, expect } from 'vitest';
import { govActionHref } from './links.js';

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
