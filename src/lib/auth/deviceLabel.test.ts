import { describe, it, expect } from 'vitest';
import { describeUserAgent, sessionDeviceLabel } from './deviceLabel.js';

describe('describeUserAgent', () => {
  it('reports a missing User-Agent as an unknown device', () => {
    expect(describeUserAgent(null)).toBe('Unknown device');
  });

  it('parses Chrome on Windows', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    expect(describeUserAgent(ua)).toBe('Chrome on Windows');
  });

  it('parses Chrome on Android', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
    expect(describeUserAgent(ua)).toBe('Chrome on Android');
  });

  it('parses Safari on iOS', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    expect(describeUserAgent(ua)).toBe('Safari on iOS');
  });

  it('parses Safari on iPadOS separately from iOS', () => {
    const ua =
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    expect(describeUserAgent(ua)).toBe('Safari on iPadOS');
  });

  it('parses Firefox on macOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0';
    expect(describeUserAgent(ua)).toBe('Firefox on macOS');
  });

  it('parses Firefox on iOS (FxiOS), not misreported as Safari', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/604.1';
    expect(describeUserAgent(ua)).toBe('Firefox on iOS');
  });

  it('parses Edge on Windows, not misreported as Chrome', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
    expect(describeUserAgent(ua)).toBe('Edge on Windows');
  });

  it('parses Chrome on Chrome OS', () => {
    const ua =
      'Mozilla/5.0 (X11; CrOS x86_64 15633.69.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    expect(describeUserAgent(ua)).toBe('Chrome on Chrome OS');
  });

  it('parses Chrome on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    expect(describeUserAgent(ua)).toBe('Chrome on Linux');
  });

  it('falls back to the raw string when it cannot identify both parts confidently', () => {
    expect(describeUserAgent('curl/8.4.0')).toBe('curl/8.4.0');
  });

  it('truncates a long, unparseable raw string instead of guessing', () => {
    const ua = `SomeUnknownBot/1.0 (+https://example.com/bot; contact=bot@example.com; extra=${'x'.repeat(40)})`;
    const result = describeUserAgent(ua);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBe(63);
    expect(ua.startsWith(result.slice(0, -3))).toBe(true);
  });
});

describe('sessionDeviceLabel', () => {
  it('returns null for a request without a User-Agent', () => {
    expect(sessionDeviceLabel(null)).toBeNull();
    expect(sessionDeviceLabel(undefined)).toBeNull();
    expect(sessionDeviceLabel('')).toBeNull();
  });

  it('describes a real User-Agent like the pairing screen does', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    expect(sessionDeviceLabel(ua)).toBe('Safari on iOS');
  });
});
