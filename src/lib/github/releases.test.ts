import { describe, it, expect } from 'vitest';
import { parseReleaseItem } from './releases.js';
import { releaseSummaryFull } from './latestRelease.js';

// ---------------------------------------------------------------------------
// releaseSummaryFull: the listing keeps the whole cleaned ## Summary paragraph,
// not just the first sentence.
// ---------------------------------------------------------------------------

describe('releaseSummaryFull', () => {
  it('keeps the whole summary paragraph, cleaned of markup', () => {
    const body =
      '## Summary\r\nDRepTalk reaches 1.0. Delegators can sign in and open a dashboard.\r\n\r\n## What\'s Changed\r\n* feat: x';
    expect(releaseSummaryFull(body)).toBe(
      'DRepTalk reaches 1.0. Delegators can sign in and open a dashboard.',
    );
  });

  it('returns empty string when the summary is only an image', () => {
    const body = '## Summary\n<img width="400" src="https://x/y.png" />\n\n## What\'s Changed';
    expect(releaseSummaryFull(body)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseReleaseItem: raw GitHub payload -> list item, or null when it should not
// be listed (draft, prerelease, missing fields). No staleness filter.
// ---------------------------------------------------------------------------

function raw(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.0.0',
    name: 'v1.0.0 delegators arrive',
    body: "## Summary\r\nDRepTalk reaches 1.0. More here.\r\n\r\n## What's Changed",
    html_url: 'https://github.com/katomm/dreptalk.com/releases/tag/v1.0.0',
    published_at: '2026-07-31T15:46:26Z',
    ...overrides,
  };
}

describe('parseReleaseItem', () => {
  it('maps a release to the list view model with the full summary', () => {
    expect(parseReleaseItem(raw())).toEqual({
      version: 'v1.0.0',
      title: 'delegators arrive',
      summary: 'DRepTalk reaches 1.0. More here.',
      url: 'https://github.com/katomm/dreptalk.com/releases/tag/v1.0.0',
      publishedAtMs: Date.parse('2026-07-31T15:46:26Z'),
    });
  });

  it('lists old releases too (no staleness filter)', () => {
    expect(parseReleaseItem(raw({ published_at: '2024-01-01T00:00:00Z' }))).not.toBeNull();
  });

  it('skips drafts and prereleases', () => {
    expect(parseReleaseItem(raw({ draft: true }))).toBeNull();
    expect(parseReleaseItem(raw({ prerelease: true }))).toBeNull();
  });

  it('returns null when tag, url or date is missing', () => {
    expect(parseReleaseItem(raw({ tag_name: '' }))).toBeNull();
    expect(parseReleaseItem(raw({ html_url: '' }))).toBeNull();
    expect(parseReleaseItem(raw({ published_at: 'not-a-date' }))).toBeNull();
  });
});
