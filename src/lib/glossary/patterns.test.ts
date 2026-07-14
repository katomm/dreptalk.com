import { readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { GLOSSARY_PATTERNS, firstMatch } from './patterns.js';

describe('GLOSSARY_PATTERNS', () => {
  it('every key has a matching glossary entry file', () => {
    const slugs = new Set(readdirSync('src/content/glossary').map((f) => f.replace(/\.md$/, '')));
    for (const { key } of GLOSSARY_PATTERNS) {
      expect(slugs.has(key), `no glossary entry for pattern key "${key}"`).toBe(true);
    }
  });

  it('no pattern carries the /g flag', () => {
    for (const { key, regex } of GLOSSARY_PATTERNS) {
      expect(regex.global, `pattern "${key}" must not be global`).toBe(false);
    }
  });

  const matchKey = (text: string, seen?: ReadonlySet<string>) => firstMatch(text, seen)?.key;

  it('longer phrases win over their substrings', () => {
    expect(matchKey('to update the constitutional committee today')).toBe('update-constitutional-committee');
    expect(matchKey('the constitutional committee voted')).toBe('constitutional-committee');
    expect(matchKey('a motion of no confidence')).toBe('motion-of-no-confidence');
    expect(matchKey('this protocol parameter change')).toBe('protocol-parameter-change');
  });

  it('matches common inflections', () => {
    expect(matchKey('two treasury withdrawals passed')).toBe('treasury-withdrawal');
    expect(matchKey('most DReps abstained')).toBe('drep');
    expect(matchKey('they abstained')).toBe('abstain');
    expect(matchKey('read the rationale')).toBe('vote-rationale');
    expect(matchKey('after the hard fork')).toBe('hard-fork-initiation');
  });

  it('skips keys already seen and reports match position', () => {
    expect(matchKey('most DReps abstained', new Set(['drep']))).toBe('abstain');
    expect(firstMatch('most DReps abstained')).toMatchObject({ key: 'drep', index: 5, length: 5 });
  });

  it('does not match inside bech32 DRep ids', () => {
    expect(matchKey('drep1abcdefghijklmnop')).toBeUndefined();
  });
});
