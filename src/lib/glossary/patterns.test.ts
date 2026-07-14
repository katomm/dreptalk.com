import { readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { GLOSSARY_PATTERNS } from './patterns.js';

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

  const firstMatch = (text: string): string | undefined => {
    let bestIdx = -1;
    let bestKey: string | undefined;
    for (const { key, regex } of GLOSSARY_PATTERNS) {
      const m = regex.exec(text);
      if (m && (bestIdx === -1 || m.index < bestIdx)) {
        bestIdx = m.index;
        bestKey = key;
      }
    }
    return bestKey;
  };

  it('longer phrases win over their substrings', () => {
    expect(firstMatch('to update the constitutional committee today')).toBe('update-constitutional-committee');
    expect(firstMatch('the constitutional committee voted')).toBe('constitutional-committee');
    expect(firstMatch('a motion of no confidence')).toBe('motion-of-no-confidence');
    expect(firstMatch('this protocol parameter change')).toBe('protocol-parameter-change');
  });

  it('matches common inflections', () => {
    expect(firstMatch('two treasury withdrawals passed')).toBe('treasury-withdrawal');
    expect(firstMatch('most DReps abstained')).toBe('drep');
    expect(firstMatch('they abstained')).toBe('abstain');
    expect(firstMatch('read the rationale')).toBe('vote-rationale');
    expect(firstMatch('after the hard fork')).toBe('hard-fork-initiation');
  });

  it('does not match inside bech32 DRep ids', () => {
    expect(firstMatch('drep1abcdefghijklmnop')).toBeUndefined();
  });
});
