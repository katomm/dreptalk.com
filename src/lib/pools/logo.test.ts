import { describe, expect, it } from 'vitest';
import { extractExtendedUrl, extractLogoUrl } from './logo.js';

describe('extractExtendedUrl', () => {
  it('pulls the extended url', () => {
    expect(extractExtendedUrl('{"name":"x","extended":"https://e/x.json"}')).toBe('https://e/x.json');
  });
  it('returns null when absent or non-https', () => {
    expect(extractExtendedUrl('{"name":"x"}')).toBeNull();
    expect(extractExtendedUrl('{"extended":"http://insecure"}')).toBeNull();
    expect(extractExtendedUrl('not json')).toBeNull();
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
