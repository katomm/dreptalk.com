import { describe, it, expect } from 'vitest';
import { parseModerators } from './moderators.js';

describe('parseModerators', () => {
  it('returns an empty map for undefined, null, or empty input', () => {
    expect(parseModerators(undefined).size).toBe(0);
    expect(parseModerators(null).size).toBe(0);
    expect(parseModerators('').size).toBe(0);
    expect(parseModerators('   ').size).toBe(0);
  });

  it('defaults a bare address to the moderator role', () => {
    const map = parseModerators('stake1abc');
    expect(map.get('stake1abc')).toBe('moderator');
  });

  it('parses an explicit admin role', () => {
    expect(parseModerators('stake1abc:admin').get('stake1abc')).toBe('admin');
  });

  it('treats any non-admin role as moderator', () => {
    expect(parseModerators('stake1abc:moderator').get('stake1abc')).toBe('moderator');
    expect(parseModerators('stake1abc:owner').get('stake1abc')).toBe('moderator');
  });

  it('parses multiple comma-separated entries and trims whitespace', () => {
    const map = parseModerators(' stake1abc : admin , stake1def ');
    expect(map.get('stake1abc')).toBe('admin');
    expect(map.get('stake1def')).toBe('moderator');
    expect(map.size).toBe(2);
  });

  it('skips empty entries', () => {
    const map = parseModerators('stake1abc,,stake1def,');
    expect(map.size).toBe(2);
  });
});
