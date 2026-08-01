import { describe, it, expect } from 'vitest';
import { releaseTitle, releaseSummary, parseRelease } from './latestRelease.js';

// ---------------------------------------------------------------------------
// releaseTitle: the human title lives in the release name as "vX.Y.Z <title>",
// so we strip the leading tag (and any separator) to avoid showing the version
// twice on the banner.
// ---------------------------------------------------------------------------

describe('releaseTitle', () => {
  it('strips the leading version tag from the release name', () => {
    expect(
      releaseTitle('v1.0.0 delegators arrive, with login and a delegation dashboard', 'v1.0.0'),
    ).toBe('delegators arrive, with login and a delegation dashboard');
  });

  it('drops a separator between tag and title', () => {
    expect(releaseTitle('v2.0.0: fresh start', 'v2.0.0')).toBe('fresh start');
  });

  it('returns an empty title when the name is only the tag', () => {
    expect(releaseTitle('v1.0.0', 'v1.0.0')).toBe('');
  });

  it('returns the name unchanged when it does not start with the tag', () => {
    expect(releaseTitle('Big release', 'v1.0.0')).toBe('Big release');
  });
});

// ---------------------------------------------------------------------------
// releaseSummary: pull one clean sentence out of the release body. Primary
// source is the "## Summary" section; a missing heading falls back to the first
// prose paragraph so a forgotten heading never breaks the banner.
// ---------------------------------------------------------------------------

describe('releaseSummary', () => {
  it('takes the first sentence of the ## Summary section', () => {
    const body =
      '## Summary\r\nDRepTalk reaches 1.0, and it now speaks to delegators too. Delegators can sign in and open a delegation dashboard.\r\n\r\n<img width="400" src="https://x/y.png" />\r\n\r\n## What\'s Changed\r\n* feat: something';
    expect(releaseSummary(body)).toBe('DRepTalk reaches 1.0, and it now speaks to delegators too.');
  });

  it('falls back to the first paragraph when there is no ## Summary heading', () => {
    const body =
      'DRepTalk now tells you when something happens. More detail follows here.\n\n## What\'s Changed\n* fix: something';
    expect(releaseSummary(body)).toBe('DRepTalk now tells you when something happens.');
  });

  it('keeps link text but drops markdown link urls', () => {
    const body = '## Summary\nSee [the docs](https://example.com) for details. Next sentence here.';
    expect(releaseSummary(body)).toBe('See the docs for details.');
  });

  it('returns empty string for an empty body', () => {
    expect(releaseSummary('')).toBe('');
  });

  it('returns empty string when the summary is only an image', () => {
    const body = '## Summary\n<img width="400" src="https://x/y.png" />\n\n## What\'s Changed\n* feat';
    expect(releaseSummary(body)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseRelease: turn the raw GitHub payload into the banner's view model, or
// null when there is nothing worth showing (missing fields or a stale release).
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-08-01T00:00:00Z');

function raw(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.0.0',
    name: 'v1.0.0 delegators arrive, with login and a delegation dashboard',
    body: '## Summary\r\nDRepTalk reaches 1.0, and it now speaks to delegators too. More here.\r\n\r\n## What\'s Changed',
    html_url: 'https://github.com/katomm/dreptalk.com/releases/tag/v1.0.0',
    published_at: '2026-07-31T15:46:26Z',
    ...overrides,
  };
}

describe('parseRelease', () => {
  it('maps a recent release to the banner view model', () => {
    expect(parseRelease(raw(), NOW)).toEqual({
      version: 'v1.0.0',
      title: 'delegators arrive, with login and a delegation dashboard',
      summary: 'DRepTalk reaches 1.0, and it now speaks to delegators too.',
      url: 'https://github.com/katomm/dreptalk.com/releases/tag/v1.0.0',
      publishedAtMs: Date.parse('2026-07-31T15:46:26Z'),
    });
  });

  it('returns null for a release older than the staleness window', () => {
    expect(parseRelease(raw({ published_at: '2026-01-01T00:00:00Z' }), NOW)).toBeNull();
  });

  it('returns null when the version tag is missing', () => {
    expect(parseRelease(raw({ tag_name: '' }), NOW)).toBeNull();
  });

  it('returns null when the release url is missing', () => {
    expect(parseRelease(raw({ html_url: '' }), NOW)).toBeNull();
  });
});
