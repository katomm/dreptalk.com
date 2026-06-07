import { describe, it, expect } from 'vitest';
import { isWriter, isModerator } from './roles.js';

describe('isWriter', () => {
  it('is true for each on-chain writer role', () => {
    expect(isWriter(['drep'])).toBe(true);
    expect(isWriter(['spo'])).toBe(true);
    expect(isWriter(['cc'])).toBe(true);
    expect(isWriter(['proposer'])).toBe(true);
  });

  it('is true when a writer role is present among others', () => {
    expect(isWriter(['member', 'proposer'])).toBe(true);
  });

  it('is false for non-writer roles and empty input', () => {
    expect(isWriter(['member'])).toBe(false);
    expect(isWriter(['admin'])).toBe(false);
    expect(isWriter(['moderator'])).toBe(false);
    expect(isWriter([])).toBe(false);
  });
});

describe('isModerator', () => {
  it('is true for admin or moderator', () => {
    expect(isModerator(['admin'])).toBe(true);
    expect(isModerator(['moderator'])).toBe(true);
    expect(isModerator(['drep', 'moderator'])).toBe(true);
  });

  it('is false for writer-only and empty input', () => {
    expect(isModerator(['drep'])).toBe(false);
    expect(isModerator(['member'])).toBe(false);
    expect(isModerator([])).toBe(false);
  });
});
