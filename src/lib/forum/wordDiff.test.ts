import { describe, it, expect } from 'vitest';
import { LCS_CELL_BUDGET, wordDiff, similarity } from './wordDiff.js';

const words = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');

describe('wordDiff', () => {
  it('marks identical text as all same', () => {
    expect(wordDiff('a b', 'a b')).toEqual([{ type: 'same', text: 'a b' }]);
  });

  it('marks a replaced word without touching its neighbours', () => {
    expect(wordDiff('I voted No today', 'I voted Abstain today')).toEqual([
      { type: 'same', text: 'I voted ' },
      { type: 'del', text: 'No' },
      { type: 'add', text: 'Abstain' },
      { type: 'same', text: ' today' },
    ]);
  });

  it('preserves whitespace runs', () => {
    expect(wordDiff('a  b', 'a  c')).toEqual([
      { type: 'same', text: 'a  ' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'c' },
    ]);
  });

  it('handles an empty old text as pure insertion', () => {
    expect(wordDiff('', 'new')).toEqual([{ type: 'add', text: 'new' }]);
  });

  it('handles fully disjoint input with no shared tokens', () => {
    expect(wordDiff('abcdef', 'xyzuvw')).toEqual([
      { type: 'del', text: 'abcdef' },
      { type: 'add', text: 'xyzuvw' },
    ]);
  });

  it('handles pure prefix insertion', () => {
    expect(wordDiff('remove', 'added remove')).toEqual([
      { type: 'add', text: 'added ' },
      { type: 'same', text: 'remove' },
    ]);
  });

  it('handles pure suffix deletion', () => {
    expect(wordDiff('keep delete', 'keep')).toEqual([
      { type: 'same', text: 'keep' },
      { type: 'del', text: ' delete' },
    ]);
  });

  it('returns a whole replacement instead of allocating an over-budget table', () => {
    // Sized just past the budget, never anywhere near the 3 GB a 20,000 character
    // paragraph of short tokens would ask for: the point is the shape of the answer,
    // and the table this asserts is not built could not be built in a test either.
    // Tokens alternate word and whitespace, so a word count of just over
    // sqrt(budget)/2 puts (n+1)*(m+1) over the line.
    const side = Math.ceil(Math.sqrt(LCS_CELL_BUDGET) / 2) + 1;
    const a = words(side, 'old');
    const b = words(side, 'new');
    expect(wordDiff(a, b)).toEqual([
      { type: 'del', text: a },
      { type: 'add', text: b },
    ]);
  });

  it('still word diffs a long pair that stays inside the budget', () => {
    // 300 words is 599 tokens a side, about 360,000 cells, so the guard must not fire
    // on anything a person would actually write in one paragraph.
    const body = words(300, 'word');
    expect(wordDiff(`${body} tail`, `${body} changed`)).toEqual([
      { type: 'same', text: `${body} ` },
      { type: 'del', text: 'tail' },
      { type: 'add', text: 'changed' },
    ]);
  });
});

describe('similarity', () => {
  it('scores identical text as 1', () => {
    expect(similarity('a b', 'a b')).toBe(1);
  });

  it('scores disjoint text as 0', () => {
    expect(similarity('a b', 'c d')).toBe(0);
  });

  it('scores a reworded line by shared words over the longer length', () => {
    expect(similarity('Beta', 'Beta changed')).toBe(0.5);
  });

  it('scores two empty strings as 1', () => {
    expect(similarity('', '')).toBe(1);
  });

  it('scores one empty side as 0', () => {
    expect(similarity('', 'word')).toBe(0);
    expect(similarity('word', '')).toBe(0);
  });

  it('handles repeated words via multiset intersection', () => {
    expect(similarity('a a b', 'a a c')).toBe(2 / 3);
  });
});
