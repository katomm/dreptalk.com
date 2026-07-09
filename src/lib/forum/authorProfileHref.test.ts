import { describe, expect, it } from 'vitest';
import { authorProfileHref, type AuthorDescriptor } from './author.js';

const base: AuthorDescriptor = { authorId: 'u1', displayName: 'x' };

describe('authorProfileHref', () => {
  it('links a DRep to its profile', () => {
    expect(authorProfileHref({ ...base, drepId: 'drep1abc', drepSlug: 'lisa-abcde' })).toBe('/dreps/lisa-abcde');
  });

  it('links an SPO to its pool profile', () => {
    expect(authorProfileHref({ ...base, poolId: 'pool1abc', poolSlug: 'hype-4x9k2' })).toBe('/spos/hype-4x9k2');
  });

  it('prefers the DRep link when an account is both', () => {
    expect(authorProfileHref({ ...base, drepId: 'drep1abc', drepSlug: null, poolId: 'pool1abc', poolSlug: 'hype-4x9k2' })).toBe('/dreps/drep1abc');
  });

  it('returns null when neither role has a profile and for system authors', () => {
    expect(authorProfileHref(base)).toBeNull();
    expect(authorProfileHref({ ...base, isSystem: true, poolId: 'pool1abc' })).toBeNull();
  });
});
