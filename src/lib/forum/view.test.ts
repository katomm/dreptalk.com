import { describe, it, expect } from 'vitest';
import { parsePage, pageToOffset, cacheControlFor, formatRelativeTime, serializeJsonLd, truncateId, truncateIdMiddle, excerptFromHtml, htmlToText, formatAda, cacheControlForSynced, recentlyActiveLabel, activeLabel } from './view.js';

// ---------------------------------------------------------------------------
// serializeJsonLd
// ---------------------------------------------------------------------------

describe('serializeJsonLd', () => {
  it('escapes </script> so it cannot break out of a <script> block', () => {
    const out = serializeJsonLd({ headline: 'foo </script><script>alert(1)</script>' });
    expect(out).toContain('<\\/script>');
    expect(out).not.toContain('</script>');
  });

  it('round-trips: JSON.parse of the output equals the original data', () => {
    const data = { headline: 'foo </script><script>alert(1)</script>', num: 42, nested: { a: true } };
    expect(JSON.parse(serializeJsonLd(data))).toEqual(data);
  });

  it('escapes all occurrences of </ in a string', () => {
    const out = serializeJsonLd({ x: 'a</b>c</d>' });
    expect(out).not.toContain('</');
    expect(out).toContain('<\\/b>');
    expect(out).toContain('<\\/d>');
  });

  it('leaves values without </ unchanged', () => {
    const data = { title: 'Hello world', count: 1 };
    expect(serializeJsonLd(data)).toBe(JSON.stringify(data));
  });
});

// ---------------------------------------------------------------------------
// truncateId
// ---------------------------------------------------------------------------

describe('truncateId', () => {
  it('returns the id unchanged when it is shorter than len', () => {
    expect(truncateId('abc', 16)).toBe('abc');
  });

  it('returns the id unchanged when it equals len exactly', () => {
    expect(truncateId('1234567890123456', 16)).toBe('1234567890123456');
  });

  it('truncates and appends "..." when id is longer than len', () => {
    expect(truncateId('12345678901234567', 16)).toBe('1234567890123456...');
  });

  it('uses default len of 16', () => {
    const long = 'a'.repeat(20);
    expect(truncateId(long)).toBe(`${'a'.repeat(16)}...`);
  });

  it('respects a custom len', () => {
    expect(truncateId('hello world', 5)).toBe('hello...');
  });
});

// ---------------------------------------------------------------------------
// truncateIdMiddle
// ---------------------------------------------------------------------------

describe('truncateIdMiddle', () => {
  it('returns a short id unchanged', () => {
    expect(truncateIdMiddle('drep1abcdef')).toBe('drep1abcdef');
  });

  it('returns an id at the exact threshold unchanged', () => {
    // head (9) + tail (8) + 3 = 20 characters
    expect(truncateIdMiddle('a'.repeat(20))).toBe('a'.repeat(20));
  });

  it('keeps the prefix and the tail of a long id', () => {
    const id = 'drep1yf3yabcdefghijklmnop0hks02d7';
    expect(truncateIdMiddle(id)).toBe('drep1yf3y...0hks02d7');
  });

  it('respects custom head and tail lengths', () => {
    const id = 'drep1234567890abcdefghijklmnopqrstuvwxyz';
    expect(truncateIdMiddle(id, 12, 6)).toBe('drep12345678...uvwxyz');
  });
});

// ---------------------------------------------------------------------------
// parsePage
// ---------------------------------------------------------------------------

describe('parsePage', () => {
  it('returns 1 for null', () => {
    expect(parsePage(null)).toBe(1);
  });

  it('returns 1 for empty string', () => {
    expect(parsePage('')).toBe(1);
  });

  it('returns 1 for non-numeric string', () => {
    expect(parsePage('abc')).toBe(1);
  });

  it('returns 1 for zero', () => {
    expect(parsePage('0')).toBe(1);
  });

  it('returns 1 for negative number', () => {
    expect(parsePage('-5')).toBe(1);
  });

  it('returns truncated integer for float string (2.7 -> 2)', () => {
    // parseInt('2.7', 10) yields 2, which is a valid page number.
    expect(parsePage('2.7')).toBe(2);
  });

  it('returns the parsed page for "1"', () => {
    expect(parsePage('1')).toBe(1);
  });

  it('returns the parsed page for "3"', () => {
    expect(parsePage('3')).toBe(3);
  });

  it('returns the parsed page for a large number', () => {
    expect(parsePage('999')).toBe(999);
  });

  it('returns 1 for "0001" (leading zeros parsed correctly)', () => {
    expect(parsePage('0001')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pageToOffset
// ---------------------------------------------------------------------------

describe('pageToOffset', () => {
  it('returns 0 for page 1', () => {
    expect(pageToOffset(1, 30)).toBe(0);
  });

  it('returns pageSize for page 2', () => {
    expect(pageToOffset(2, 30)).toBe(30);
  });

  it('returns 2*pageSize for page 3', () => {
    expect(pageToOffset(3, 30)).toBe(60);
  });

  it('works with a different pageSize', () => {
    expect(pageToOffset(2, 50)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// cacheControlFor
// ---------------------------------------------------------------------------

describe('cacheControlFor', () => {
  it('returns private no-store when user is present', () => {
    expect(cacheControlFor({ id: 'u1', roles: [] })).toBe('private, no-store');
  });

  it('returns public s-maxage when user is null', () => {
    expect(cacheControlFor(null)).toBe('public, s-maxage=30');
  });

  it('returns public s-maxage when user is undefined', () => {
    expect(cacheControlFor(undefined)).toBe('public, s-maxage=30');
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

describe('formatRelativeTime', () => {
  const NOW = 1_750_000_000_000;

  it('shows "just now" for 0 seconds ago', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
  });

  it('shows "just now" for 30 seconds ago', () => {
    expect(formatRelativeTime(NOW - 30 * SEC, NOW)).toBe('just now');
  });

  it('shows "1m ago" for 90 seconds ago', () => {
    expect(formatRelativeTime(NOW - 90 * SEC, NOW)).toBe('1m ago');
  });

  it('shows "5m ago" for 5 minutes ago', () => {
    expect(formatRelativeTime(NOW - 5 * MIN, NOW)).toBe('5m ago');
  });

  it('shows "59m ago" for 59 minutes ago', () => {
    expect(formatRelativeTime(NOW - 59 * MIN, NOW)).toBe('59m ago');
  });

  it('shows "1h ago" for 1 hour ago', () => {
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe('1h ago');
  });

  it('shows "2h ago" for 2 hours ago', () => {
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW)).toBe('2h ago');
  });

  it('shows "23h ago" for 23 hours ago', () => {
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe('23h ago');
  });

  it('shows "1d ago" for 1 day ago', () => {
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe('1d ago');
  });

  it('shows "3d ago" for 3 days ago', () => {
    expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe('3d ago');
  });

  it('shows "29d ago" for 29 days ago', () => {
    expect(formatRelativeTime(NOW - 29 * DAY, NOW)).toBe('29d ago');
  });

  it('shows "1mo ago" for 30 days ago', () => {
    expect(formatRelativeTime(NOW - MONTH, NOW)).toBe('1mo ago');
  });

  it('shows "6mo ago" for 6 months ago', () => {
    expect(formatRelativeTime(NOW - 6 * MONTH, NOW)).toBe('6mo ago');
  });

  it('shows "11mo ago" for 11 months ago', () => {
    expect(formatRelativeTime(NOW - 11 * MONTH, NOW)).toBe('11mo ago');
  });

  it('shows "1y ago" for 1 year ago', () => {
    expect(formatRelativeTime(NOW - YEAR, NOW)).toBe('1y ago');
  });

  it('shows "2y ago" for 2 years ago', () => {
    expect(formatRelativeTime(NOW - 2 * YEAR, NOW)).toBe('2y ago');
  });
});

// ---------------------------------------------------------------------------
// excerptFromHtml
// ---------------------------------------------------------------------------

describe('htmlToText', () => {
  it('strips tags, decodes entities, collapses whitespace, no truncation', () => {
    expect(htmlToText('<p>Hello <strong>world</strong> &amp; more</p>')).toBe('Hello world & more');
    expect(htmlToText(`<p>${'x '.repeat(200)}</p>`).length).toBeGreaterThan(155);
  });
  it('returns empty for tag-only or empty input', () => {
    expect(htmlToText('<p></p>')).toBe('');
    expect(htmlToText('')).toBe('');
  });
});

describe('excerptFromHtml', () => {
  it('strips tags and collapses whitespace', () => {
    expect(excerptFromHtml('<p>Hello   <strong>world</strong></p>')).toBe('Hello world');
  });

  it('returns short text unchanged', () => {
    expect(excerptFromHtml('<p>Short.</p>')).toBe('Short.');
  });

  it('truncates with an ellipsis past maxLen', () => {
    const out = excerptFromHtml(`<p>${'a '.repeat(20)}</p>`, 10);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(13);
  });

  it('cuts on a word boundary, never mid-word', () => {
    expect(excerptFromHtml('<p>Governance parameters proposal</p>', 20)).toBe('Governance...');
  });

  it('hard-cuts a single over-long token with no space', () => {
    expect(excerptFromHtml('<p>Supercalifragilistic</p>', 10)).toBe('Supercali...');
  });

  it('handles empty input', () => {
    expect(excerptFromHtml('')).toBe('');
  });

  it('decodes named, numeric and hex entities to plain text', () => {
    expect(excerptFromHtml('<p>It&#39;s a &quot;test&quot; with R&amp;D &amp; M&#x26;A</p>')).toBe(
      'It\'s a "test" with R&D & M&A',
    );
  });
});

// ---------------------------------------------------------------------------
// formatAda
// ---------------------------------------------------------------------------

describe('formatAda', () => {
  it('formats lovelace as whole ADA with a symbol and thousands separators', () => {
    expect(formatAda('5000000000')).toBe('5,000 ₳');
  });
  it('treats null as zero', () => {
    expect(formatAda(null)).toBe('0 ₳');
  });
});

// ---------------------------------------------------------------------------
// cacheControlForSynced
// ---------------------------------------------------------------------------

describe('cacheControlForSynced', () => {
  it('caches anonymous sync-driven pages longer than the 30s thread default', () => {
    expect(cacheControlForSynced(null)).toBe('public, s-maxage=300');
  });
  it('never caches for logged-in users', () => {
    expect(cacheControlForSynced({ id: 'u' })).toBe('private, no-store');
  });
});

// ---------------------------------------------------------------------------
// recentlyActiveLabel
// ---------------------------------------------------------------------------

describe('recentlyActiveLabel', () => {
  it('returns both DReps and SPOs with "and" conjunction', () => {
    expect(recentlyActiveLabel(3, 2)).toBe('3 DReps and 2 SPOs active recently on DRepTalk');
  });

  it('handles singular forms', () => {
    expect(recentlyActiveLabel(1, 1)).toBe('1 DRep and 1 SPO active recently on DRepTalk');
  });

  it('returns only DReps when SPO count is zero', () => {
    expect(recentlyActiveLabel(5, 0)).toBe('5 DReps active recently on DRepTalk');
  });

  it('returns only SPOs when DRep count is zero', () => {
    expect(recentlyActiveLabel(0, 3)).toBe('3 SPOs active recently on DRepTalk');
  });

  it('returns null when both counts are zero', () => {
    expect(recentlyActiveLabel(0, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// activeLabel
// ---------------------------------------------------------------------------

describe('activeLabel', () => {
  it('returns dreps and spos only when delegators are below threshold', () => {
    expect(activeLabel({ dreps: 42, spos: 8, delegators: 0 })).toBe(
      '42 DReps and 8 SPOs active in the last 30 days on DRepTalk',
    );
  });

  it('includes delegators at the threshold', () => {
    expect(activeLabel({ dreps: 42, spos: 8, delegators: 25 })).toBe(
      '42 DReps, 8 SPOs and 25 delegators active in the last 30 days on DRepTalk',
    );
  });

  it('excludes delegators below the threshold', () => {
    expect(activeLabel({ dreps: 42, spos: 8, delegators: 24 })).toBe(
      '42 DReps and 8 SPOs active in the last 30 days on DRepTalk',
    );
  });

  it('handles singular forms correctly', () => {
    expect(activeLabel({ dreps: 1, spos: 0, delegators: 0 })).toBe(
      '1 DRep active in the last 30 days on DRepTalk',
    );
  });

  it('returns null when no dreps or spos are active', () => {
    expect(activeLabel({ dreps: 0, spos: 0, delegators: 100 })).toBeNull();
  });
});
