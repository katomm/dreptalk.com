import { describe, it, expect } from 'vitest';
import { classifySocialLink, splitSocialLinks } from './socialLinks.js';

describe('classifySocialLink', () => {
  it('recognizes the supported platforms by hostname', () => {
    expect(classifySocialLink('https://x.com/someone')).toBe('x');
    expect(classifySocialLink('https://twitter.com/someone')).toBe('x');
    expect(classifySocialLink('https://bsky.app/profile/someone.bsky.social')).toBe('bluesky');
    expect(classifySocialLink('https://www.linkedin.com/in/someone/')).toBe('linkedin');
    expect(classifySocialLink('https://facebook.com/someone')).toBe('facebook');
    expect(classifySocialLink('https://github.com/someone')).toBe('github');
    expect(classifySocialLink('https://discord.gg/abc123')).toBe('discord');
    expect(classifySocialLink('https://t.me/someone')).toBe('telegram');
    expect(classifySocialLink('https://youtube.com/@someone')).toBe('youtube');
    expect(classifySocialLink('https://www.instagram.com/someone')).toBe('instagram');
  });

  it('matches subdomains but never path segments or look-alike hosts', () => {
    expect(classifySocialLink('https://gist.github.com/someone')).toBe('github');
    expect(classifySocialLink('https://evil.com/x.com')).toBeNull();
    expect(classifySocialLink('https://x.com.evil.com/')).toBeNull();
    expect(classifySocialLink('https://notgithub.com/')).toBeNull();
  });

  it('rejects non-http schemes and unparsable input', () => {
    expect(classifySocialLink('mailto:me@x.com')).toBeNull();
    expect(classifySocialLink('not a url')).toBeNull();
  });
});

describe('splitSocialLinks', () => {
  it('splits recognized links from the rest, preserving order and labels', () => {
    const { social, rest, overflowKinds } = splitSocialLinks([
      { label: 'My site', uri: 'https://example.com/' },
      { label: '', uri: 'https://x.com/someone' },
      { label: 'Code', uri: 'https://github.com/someone' },
    ]);
    expect(social).toEqual([
      { kind: 'x', uri: 'https://x.com/someone', label: 'X' },
      { kind: 'github', uri: 'https://github.com/someone', label: 'Code' },
    ]);
    expect(rest).toEqual([{ label: 'My site', uri: 'https://example.com/' }]);
    expect(overflowKinds).toEqual([]);
  });

  it('handles empty input', () => {
    expect(splitSocialLinks([])).toEqual({ social: [], rest: [], overflowKinds: [] });
  });

  it('keeps only the first link per platform in the icon row, rest go to About', () => {
    const { social, rest, overflowKinds } = splitSocialLinks([
      { label: 'Profile', uri: 'https://x.com/someone' },
      { label: 'Pinned tweet', uri: 'https://x.com/someone/status/123' },
      { label: '', uri: 'https://bsky.app/profile/someone' },
      { label: 'Bsky highlight', uri: 'https://bsky.app/profile/someone/post/abc' },
      { label: 'Code', uri: 'https://github.com/someone' },
    ]);
    expect(social).toEqual([
      { kind: 'x', uri: 'https://x.com/someone', label: 'Profile' },
      { kind: 'bluesky', uri: 'https://bsky.app/profile/someone', label: 'Bluesky' },
      { kind: 'github', uri: 'https://github.com/someone', label: 'Code' },
    ]);
    expect(rest).toEqual([
      { label: 'Pinned tweet', uri: 'https://x.com/someone/status/123' },
      { label: 'Bsky highlight', uri: 'https://bsky.app/profile/someone/post/abc' },
    ]);
    expect(overflowKinds).toEqual(['x', 'bluesky']);
  });
});
