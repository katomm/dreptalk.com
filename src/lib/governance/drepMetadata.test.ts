import { describe, it, expect } from 'vitest';
import { buildDrepMetadata, MAX_DREP_NAME, MAX_DREP_BIO, MAX_DREP_LINKS } from './drepMetadata.js';

describe('buildDrepMetadata', () => {
  it('produces deterministic body and a valid 64-char hex hash', () => {
    const input = {
      name: 'Alice Cardano',
      bio: 'I want to improve governance.',
      links: ['https://alice.example.com', 'https://twitter.com/alice'],
    };
    const r1 = buildDrepMetadata(input);
    const r2 = buildDrepMetadata(input);

    expect(r1.body).toBe(r2.body);
    expect(r1.hash).toBe(r2.hash);
    expect(r1.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('strips control characters from name and bio', () => {
    // "AB" with a null byte (\x00) between A and B becomes "AB"
    const result = buildDrepMetadata({ name: 'A\x00B', bio: 'fine', links: [] });
    expect(result.name).toBe('AB');
  });

  it('drops javascript: and other non-http(s) links, keeps https', () => {
    const result = buildDrepMetadata({
      name: 'Bob',
      bio: 'bio',
      links: ['javascript:alert(1)', 'https://bob.example.com', 'ftp://example.com'],
    });
    expect(result.links).toEqual(['https://bob.example.com']);
  });

  it('truncates name at MAX_DREP_NAME characters', () => {
    const longName = 'N'.repeat(MAX_DREP_NAME + 20);
    const result = buildDrepMetadata({ name: longName, bio: '', links: [] });
    expect(result.name.length).toBe(MAX_DREP_NAME);
  });

  it('truncates bio at MAX_DREP_BIO characters', () => {
    const longBio = 'B'.repeat(MAX_DREP_BIO + 50);
    const result = buildDrepMetadata({ name: 'Test', bio: longBio, links: [] });
    expect(result.bio.length).toBe(MAX_DREP_BIO);
  });

  it('caps links at MAX_DREP_LINKS', () => {
    const many = Array.from({ length: MAX_DREP_LINKS + 5 }, (_, i) => `https://example.com/${i}`);
    const result = buildDrepMetadata({ name: 'Test', bio: '', links: many });
    expect(result.links.length).toBe(MAX_DREP_LINKS);
  });

  it('embeds givenName and objectives in the JSON body under CIP-119 structure', () => {
    const result = buildDrepMetadata({
      name: 'Carol',
      bio: 'My objectives.',
      links: ['https://carol.example.com'],
    });
    const parsed = JSON.parse(result.body);
    expect(parsed.body.givenName).toBe('Carol');
    expect(parsed.body.objectives).toBe('My objectives.');
    expect(parsed.body.references[0].uri).toBe('https://carol.example.com');
    expect(parsed.hashAlgorithm).toBe('blake2b-256');
  });

  it('hash matches blake2b-256 of the body string bytes', async () => {
    // Verify the hash is actually blake2b-256(utf8(body)) and not something else.
    const { blake2b256 } = await import('../crypto/blake.js');
    const { bytesToHex } = await import('../crypto/hex.js');
    const result = buildDrepMetadata({ name: 'Dave', bio: 'Test', links: [] });
    const expected = bytesToHex(blake2b256(new TextEncoder().encode(result.body)));
    expect(result.hash).toBe(expected);
  });
});

describe('buildDrepMetadata image', () => {
  const base = { name: 'Test', bio: '', links: [] as string[] };

  it('omits the image key entirely when no image is given', () => {
    const m = buildDrepMetadata(base);
    expect(JSON.parse(m.body).body.image).toBeUndefined();
  });

  it('embeds an ImageObject with contentUrl and sha256', () => {
    const m = buildDrepMetadata({
      ...base,
      image: { url: `https://dreptalk.com/api/avatar/${'ab'.repeat(32)}`, sha256: 'ab'.repeat(32) },
    });
    expect(JSON.parse(m.body).body.image).toEqual({
      '@type': 'ImageObject',
      contentUrl: `https://dreptalk.com/api/avatar/${'ab'.repeat(32)}`,
      sha256: 'ab'.repeat(32),
    });
  });

  it('omits sha256 when not provided', () => {
    const m = buildDrepMetadata({ ...base, image: { url: 'https://example.com/me.png' } });
    expect(JSON.parse(m.body).body.image).toEqual({
      '@type': 'ImageObject',
      contentUrl: 'https://example.com/me.png',
    });
  });

  it('drops a non-https image URL', () => {
    const m = buildDrepMetadata({ ...base, image: { url: 'data:image/png;base64,AAAA' } });
    expect(JSON.parse(m.body).body.image).toBeUndefined();
  });

  it('is hash-deterministic for the same image input', () => {
    const input = { ...base, image: { url: 'https://example.com/me.png', sha256: 'cd'.repeat(32) } };
    expect(buildDrepMetadata(input).hash).toBe(buildDrepMetadata(input).hash);
  });
});
