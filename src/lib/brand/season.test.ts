import { describe, expect, it } from 'vitest';
import { isHatSeason, showLogoHat } from './season';

describe('isHatSeason', () => {
  it('covers December 1 through January 6', () => {
    expect(isHatSeason(new Date('2026-11-30T23:59:59Z'))).toBe(false);
    expect(isHatSeason(new Date('2026-12-01T00:00:00Z'))).toBe(true);
    expect(isHatSeason(new Date('2026-12-31T12:00:00Z'))).toBe(true);
    expect(isHatSeason(new Date('2027-01-06T23:59:59Z'))).toBe(true);
    expect(isHatSeason(new Date('2027-01-07T00:00:00Z'))).toBe(false);
    expect(isHatSeason(new Date('2026-07-15T12:00:00Z'))).toBe(false);
  });
});

describe('showLogoHat', () => {
  const october = new Date('2026-10-24T12:00:00Z');
  const december = new Date('2026-12-24T12:00:00Z');

  it('follows the calendar without a param', () => {
    expect(showLogoHat(new URL('https://dreptalk.com/'), october)).toBe(false);
    expect(showLogoHat(new URL('https://dreptalk.com/'), december)).toBe(true);
  });

  it('lets ?hat=1 and ?hat=0 override the calendar', () => {
    expect(showLogoHat(new URL('https://dreptalk.com/?hat=1'), october)).toBe(true);
    expect(showLogoHat(new URL('https://dreptalk.com/?hat=0'), december)).toBe(false);
    expect(showLogoHat(new URL('https://dreptalk.com/?hat=yes'), october)).toBe(false);
  });
});
