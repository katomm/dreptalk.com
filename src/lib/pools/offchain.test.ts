import { describe, expect, it } from 'vitest';
import {
  EMPTY_IDENTITY,
  extractExtendedUrl,
  extractLogoUrl,
  extractPoolIdentity,
  parseRecord,
  sanitizePoolIdentity,
} from './offchain.js';

describe('parseRecord', () => {
  it('returns the object for a JSON object', () => {
    expect(parseRecord('{"name":"x"}')).toEqual({ name: 'x' });
  });
  it('returns null for anything else', () => {
    expect(parseRecord('not json')).toBeNull();
    expect(parseRecord('"a string"')).toBeNull();
    expect(parseRecord('null')).toBeNull();
  });
});

describe('extractExtendedUrl', () => {
  it('pulls the extended url', () => {
    expect(extractExtendedUrl(parseRecord('{"name":"x","extended":"https://e/x.json"}'))).toBe('https://e/x.json');
  });
  it('returns null when absent or non-https', () => {
    expect(extractExtendedUrl(parseRecord('{"name":"x"}'))).toBeNull();
    expect(extractExtendedUrl(parseRecord('{"extended":"http://insecure"}'))).toBeNull();
    expect(extractExtendedUrl(null)).toBeNull();
  });
});

describe('extractLogoUrl', () => {
  it('prefers info.url_png_icon_64x64', () => {
    expect(
      extractLogoUrl({ info: { url_png_icon_64x64: 'https://i/64.png', url_png_logo: 'https://i/big.png' } }),
    ).toBe('https://i/64.png');
  });
  it('supports the legacy adapools key', () => {
    expect(extractLogoUrl({ adapools: { url_png_icon_64x64: 'https://a/64.png' } })).toBe('https://a/64.png');
  });
  it('falls back to url_png_logo', () => {
    expect(extractLogoUrl({ info: { url_png_logo: 'https://i/logo.png' } })).toBe('https://i/logo.png');
  });
  it('returns null when no https raster field exists', () => {
    expect(extractLogoUrl({ info: { social: { twitter_handle: 'x' } } })).toBeNull();
    expect(extractLogoUrl({ info: { url_png_icon_64x64: 'http://insecure.png' } })).toBeNull();
    expect(extractLogoUrl({})).toBeNull();
    expect(extractLogoUrl(null)).toBeNull();
  });
});

describe('extractPoolIdentity', () => {
  it('reads the registered identity fields', () => {
    expect(
      extractPoolIdentity(
        parseRecord(
          '{"name":"CLIO1","ticker":"CLIO1","homepage":"https://clio.one","description":"past is prologue"}',
        ),
      ),
    ).toEqual({
      name: 'CLIO1',
      ticker: 'CLIO1',
      homepage: 'https://clio.one',
      description: 'past is prologue',
    });
  });
  it('returns the empty identity for an unparsable document', () => {
    expect(extractPoolIdentity(null)).toEqual(EMPTY_IDENTITY);
  });
});

describe('sanitizePoolIdentity', () => {
  it('treats blank and non-string fields as absent', () => {
    expect(sanitizePoolIdentity({ name: '  ', ticker: 7, homepage: null })).toEqual(EMPTY_IDENTITY);
  });
  it('trims surrounding whitespace', () => {
    expect(sanitizePoolIdentity({ name: ' Stake Cool ' }).name).toBe('Stake Cool');
  });
  it('caps the length of the free text fields', () => {
    const long = 'N'.repeat(900);
    expect(sanitizePoolIdentity({ name: long }).name?.length).toBe(80);
    expect(sanitizePoolIdentity({ ticker: long }).ticker?.length).toBe(16);
    expect(sanitizePoolIdentity({ description: long }).description?.length).toBe(500);
  });
  it('keeps only http and https homepages, since it is rendered as a link', () => {
    expect(sanitizePoolIdentity({ homepage: 'https://clio.one' }).homepage).toBe('https://clio.one');
    expect(sanitizePoolIdentity({ homepage: 'http://honeypuck.com' }).homepage).toBe('http://honeypuck.com');
    expect(sanitizePoolIdentity({ homepage: 'javascript:alert(1)' }).homepage).toBeNull();
    expect(sanitizePoolIdentity({ homepage: 'data:text/html,<x>' }).homepage).toBeNull();
  });
});
