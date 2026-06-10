import { describe, it, expect } from 'vitest';
import { extractCip119Profile } from './metadata.js';

// Helper: build a canonical full CIP-119 doc with all fields under body.
function fullDoc() {
  return {
    '@context': {},
    hashAlgorithm: 'blake2b-256',
    body: {
      givenName: 'Alice DRep',
      objectives: 'Cardano governance for all.',
      image: 'https://example.com/avatar.png',
      references: [
        { '@type': 'Link', label: 'GitHub', uri: 'https://github.com/alice' },
        { '@type': 'Link', label: 'Twitter', uri: 'https://twitter.com/alice' },
      ],
    },
  };
}

describe('extractCip119Profile', () => {
  it('extracts all fields from a full valid doc (body-nested)', () => {
    const profile = extractCip119Profile(fullDoc());
    expect(profile.name).toBe('Alice DRep');
    expect(profile.bio).toBe('Cardano governance for all.');
    expect(profile.imageUrl).toBe('https://example.com/avatar.png');
    expect(profile.links).toEqual([
      { label: 'GitHub', uri: 'https://github.com/alice' },
      { label: 'Twitter', uri: 'https://twitter.com/alice' },
    ]);
  });

  it('falls back to root-level fields when there is no body wrapper', () => {
    const doc = {
      givenName: 'Bob DRep',
      bio: 'Stake pool operator.',
      image: 'https://cdn.example.com/bob.jpg',
      references: [{ '@type': 'Link', label: 'Website', uri: 'https://bob.io' }],
    };
    const profile = extractCip119Profile(doc);
    expect(profile.name).toBe('Bob DRep');
    expect(profile.bio).toBe('Stake pool operator.');
    expect(profile.imageUrl).toBe('https://cdn.example.com/bob.jpg');
    expect(profile.links).toEqual([{ label: 'Website', uri: 'https://bob.io' }]);
  });

  it('accepts image as an object with contentUrl', () => {
    const doc = {
      body: {
        givenName: 'Carol',
        image: { contentUrl: 'https://images.example.com/carol.png' },
      },
    };
    const profile = extractCip119Profile(doc);
    expect(profile.imageUrl).toBe('https://images.example.com/carol.png');
  });

  it('drops a javascript: image URL', () => {
    const doc = { body: { givenName: 'Evil', image: 'javascript:alert(1)' } };
    const profile = extractCip119Profile(doc);
    expect(profile.imageUrl).toBeNull();
  });

  it('drops a data: image URL', () => {
    const doc = { body: { givenName: 'Evil', image: 'data:image/png;base64,abc123' } };
    const profile = extractCip119Profile(doc);
    expect(profile.imageUrl).toBeNull();
  });

  it('resolves an ipfs: image URL to the public gateway', () => {
    const doc = { body: { image: 'ipfs://QmSomeHash' } };
    const profile = extractCip119Profile(doc);
    expect(profile.imageUrl).toBe('https://ipfs.io/ipfs/QmSomeHash');
  });

  it('resolves an ipfs: contentUrl in an ImageObject to the gateway', () => {
    const doc = { body: { image: { contentUrl: 'ipfs://QmOtherHash/avatar.png' } } };
    const profile = extractCip119Profile(doc);
    expect(profile.imageUrl).toBe('https://ipfs.io/ipfs/QmOtherHash/avatar.png');
  });

  it('keeps only http(s) references, dropping junk entries', () => {
    const doc = {
      body: {
        references: [
          { '@type': 'Link', label: 'Good', uri: 'https://good.example.com' },
          { '@type': 'Link', label: 'Also good', uri: 'http://also-good.example.com' },
          { '@type': 'Link', label: 'Junk', uri: 'javascript:void(0)' },
          { '@type': 'Link', label: 'Data', uri: 'data:text/html,<h1>x</h1>' },
          { '@type': 'Other', label: 'No URL at all' },
          { '@type': 'Link', label: 'IPFS', uri: 'ipfs://QmSomeHash' },
          42, // not an object
          null,
        ],
      },
    };
    const profile = extractCip119Profile(doc);
    expect(profile.links).toEqual([
      { label: 'Good', uri: 'https://good.example.com' },
      { label: 'Also good', uri: 'http://also-good.example.com' },
    ]);
  });

  it('uses bio field when both bio and objectives are present (bio preferred)', () => {
    const doc = {
      body: {
        bio: 'I am a DRep.',
        objectives: 'My objectives are.',
      },
    };
    const profile = extractCip119Profile(doc);
    expect(profile.bio).toBe('I am a DRep.');
  });

  it('falls back to objectives when bio is missing or empty', () => {
    const doc = { body: { objectives: 'Objectives text.' } };
    expect(extractCip119Profile(doc).bio).toBe('Objectives text.');

    const doc2 = { body: { bio: '', objectives: 'Fallback objectives.' } };
    expect(extractCip119Profile(doc2).bio).toBe('Fallback objectives.');
  });

  it('caps name at 80 characters', () => {
    const longName = 'A'.repeat(100);
    const doc = { body: { givenName: longName } };
    const profile = extractCip119Profile(doc);
    expect(profile.name).toHaveLength(80);
  });

  it('caps bio at 1000 characters', () => {
    const longBio = 'B'.repeat(1500);
    const doc = { body: { bio: longBio } };
    const profile = extractCip119Profile(doc);
    expect(profile.bio!.length).toBe(1000);
  });

  it('caps imageUrl at 2048 characters', () => {
    // Construct a valid https URL that is longer than 2048 chars.
    const path = 'x'.repeat(2100);
    const url = `https://example.com/${path}`;
    const doc = { body: { image: url } };
    const profile = extractCip119Profile(doc);
    // The URL is valid but capped: the stored value must not exceed 2048 chars.
    expect(profile.imageUrl!.length).toBeLessThanOrEqual(2048);
  });

  it('caps the links array at 10 entries', () => {
    const refs = Array.from({ length: 15 }, (_, i) => ({
      '@type': 'Link',
      label: `Link ${i}`,
      uri: `https://example.com/${i}`,
    }));
    const doc = { body: { references: refs } };
    const profile = extractCip119Profile(doc);
    expect(profile.links).toHaveLength(10);
  });

  it('caps link label at 100 characters', () => {
    const doc = {
      body: {
        references: [{ label: 'L'.repeat(200), uri: 'https://example.com' }],
      },
    };
    const profile = extractCip119Profile(doc);
    expect(profile.links![0].label.length).toBe(100);
  });

  it('caps link uri at 2048 characters', () => {
    const path = 'p'.repeat(2100);
    const longUri = `https://example.com/${path}`;
    const doc = {
      body: {
        references: [{ label: 'Test', uri: longUri }],
      },
    };
    const profile = extractCip119Profile(doc);
    expect(profile.links![0].uri.length).toBeLessThanOrEqual(2048);
  });

  it('returns all-null profile for an empty/garbage doc, never throws', () => {
    expect(() => extractCip119Profile(null)).not.toThrow();
    expect(() => extractCip119Profile(undefined)).not.toThrow();
    expect(() => extractCip119Profile(42)).not.toThrow();
    expect(() => extractCip119Profile('string')).not.toThrow();
    expect(() => extractCip119Profile({})).not.toThrow();

    const profile = extractCip119Profile({});
    expect(profile.name).toBeNull();
    expect(profile.bio).toBeNull();
    expect(profile.imageUrl).toBeNull();
    expect(profile.links).toBeNull();
  });

  it('sanitizes control characters from name and bio', () => {
    const doc = {
      body: {
        givenName: 'Alice\x00\x01DRep',
        bio: 'Bio\x07with\x1Fcontrols',
      },
    };
    const profile = extractCip119Profile(doc);
    expect(profile.name).toBe('AliceDRep');
    expect(profile.bio).toBe('Biowithcontrols');
  });
});
