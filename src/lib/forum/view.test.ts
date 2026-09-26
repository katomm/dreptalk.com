import { describe, it, expect } from 'vitest';
import { parsePage, pageToOffset, cacheControlFor, formatRelativeTime, serializeJsonLd, truncateId, truncateIdMiddle, excerptFromHtml, htmlToText, formatAda, cacheControlForSynced, activeLabel } from './view.js';

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
  it.each([
    ['shorter than len', 'abc', 16, 'abc'],
    ['exactly len', '1234567890123456', 16, '1234567890123456'],
    ['one past len', '12345678901234567', 16, '1234567890123456...'],
    ['default len of 16', 'a'.repeat(20), undefined, `${'a'.repeat(16)}...`],
    ['custom len', 'hello world', 5, 'hello...'],
  ])('%s', (_label, id, len, expected) => {
    expect(truncateId(id, len)).toBe(expected);
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
  // parseInt('2.7', 10) yields 2, which is a valid page number.
  it.each([
    [null, 1],
    ['', 1],
    ['abc', 1],
    ['0', 1],
    ['-5', 1],
    ['2.7', 2],
    ['1', 1],
    ['999', 999],
    ['0001', 1],
  ])('parsePage(%j) is %i', (param, expected) => {
    expect(parsePage(param)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// pageToOffset
// ---------------------------------------------------------------------------

describe('pageToOffset', () => {
  it.each([
    [1, 30, 0],
    [3, 30, 60],
    [2, 50, 50],
  ])('page %i with size %i starts at offset %i', (page, size, expected) => {
    expect(pageToOffset(page, size)).toBe(expected);
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
    expect(cacheControlFor(null)).toBe('public, s-maxage=60, stale-while-revalidate=600');
  });

  it('returns public s-maxage when user is undefined', () => {
    expect(cacheControlFor(undefined)).toBe('public, s-maxage=60, stale-while-revalidate=600');
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

  it.each([
    [0, 'just now'],
    [30 * SEC, 'just now'],
    [90 * SEC, '1m ago'],
    [59 * MIN, '59m ago'],
    [HOUR, '1h ago'],
    [23 * HOUR, '23h ago'],
    [DAY, '1d ago'],
    [29 * DAY, '29d ago'],
    [MONTH, '1mo ago'],
    [11 * MONTH, '11mo ago'],
    [YEAR, '1y ago'],
    [2 * YEAR, '2y ago'],
  ])('%i ms ago shows "%s"', (ago, expected) => {
    expect(formatRelativeTime(NOW - ago, NOW)).toBe(expected);
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
  it('formats lovelace as whole ada with a symbol and thousands separators', () => {
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
