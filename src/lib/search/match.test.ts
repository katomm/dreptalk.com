import { describe, it, expect } from 'vitest';
import { buildMatch } from './match.js';

describe('buildMatch', () => {
  it('quotes a single token and adds a prefix star', () => {
    expect(buildMatch('treasury')).toBe('"treasury"*');
  });

  it('quotes every token and stars only the last', () => {
    expect(buildMatch('net change limit')).toBe('"net" "change" "limit"*');
  });

  it('neutralizes FTS5 operators into quoted literals', () => {
    expect(buildMatch('treasury OR budget')).toBe('"treasury" "OR" "budget"*');
    expect(buildMatch('NOT near(x)')).toBe('"NOT" "near(x)"*');
  });

  it('strips double quotes from the input', () => {
    expect(buildMatch('say "hello" world')).toBe('"say" "hello" "world"*');
  });

  it('strips Unicode curly quotes from the input', () => {
    expect(buildMatch('“governance”')).toBe('"governance"*');
  });

  it('drops tokens without letters or digits', () => {
    expect(buildMatch('a & b')).toBe('"a" "b"*');
    expect(buildMatch('- - -')).toBeNull();
  });

  it('returns null for empty, whitespace, and symbol-only input', () => {
    expect(buildMatch('')).toBeNull();
    expect(buildMatch('   ')).toBeNull();
    expect(buildMatch('()*')).toBeNull();
  });

  it('caps at 8 tokens', () => {
    expect(buildMatch('a b c d e f g h i j')).toBe('"a" "b" "c" "d" "e" "f" "g" "h"*');
  });

  it('keeps identifiers and unicode intact as single tokens', () => {
    expect(buildMatch('gov_action1abc')).toBe('"gov_action1abc"*');
    expect(buildMatch('Verfassung')).toBe('"Verfassung"*');
  });
});
