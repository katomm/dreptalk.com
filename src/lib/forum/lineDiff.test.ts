import { describe, it, expect } from 'vitest';
import { lineDiff, lineDiffWithWords } from './lineDiff.js';

describe('lineDiff', () => {
  it('marks identical text as all same', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'same', line: 'a' },
      { type: 'same', line: 'b' },
    ]);
  });

  it('detects an added line', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual([
      { type: 'same', line: 'a' },
      { type: 'add', line: 'b' },
      { type: 'same', line: 'c' },
    ]);
  });

  it('detects a removed line', () => {
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual([
      { type: 'same', line: 'a' },
      { type: 'del', line: 'b' },
      { type: 'same', line: 'c' },
    ]);
  });

  it('represents a changed line as del then add', () => {
    expect(lineDiff('hello', 'world')).toEqual([
      { type: 'del', line: 'hello' },
      { type: 'add', line: 'world' },
    ]);
  });
});

describe('lineDiffWithWords', () => {
  it('word diffs a reworded line', () => {
    expect(lineDiffWithWords('the budget is high', 'the budget seems high')).toEqual([
      {
        type: 'del',
        parts: [
          { type: 'same', text: 'the budget ' },
          { type: 'del', text: 'is' },
          { type: 'same', text: ' high' },
        ],
      },
      {
        type: 'add',
        parts: [
          { type: 'same', text: 'the budget ' },
          { type: 'add', text: 'seems' },
          { type: 'same', text: ' high' },
        ],
      },
    ]);
  });

  it('pairs deletions with insertions by position within a run', () => {
    // Deletion 1 ('one alpha') must pair with insertion 1 ('one gamma'), not
    // insertion 2. An implementation that zipped by the wrong offset would
    // still produce four marked lines, so the pairing itself has to be
    // visible: the shared prefix on each line proves which old line paired
    // with which new line.
    expect(lineDiffWithWords('one alpha\ntwo beta', 'one gamma\ntwo delta')).toEqual([
      {
        type: 'del',
        parts: [
          { type: 'same', text: 'one ' },
          { type: 'del', text: 'alpha' },
        ],
      },
      {
        type: 'add',
        parts: [
          { type: 'same', text: 'one ' },
          { type: 'add', text: 'gamma' },
        ],
      },
      {
        type: 'del',
        parts: [
          { type: 'same', text: 'two ' },
          { type: 'del', text: 'beta' },
        ],
      },
      {
        type: 'add',
        parts: [
          { type: 'same', text: 'two ' },
          { type: 'add', text: 'delta' },
        ],
      },
    ]);
  });

  it('leaves a dissimilar pair as whole-line changes', () => {
    const out = lineDiffWithWords('completely different text here', 'nothing alike');
    for (const line of out) {
      expect(line.parts).toHaveLength(1);
      expect(line.parts[0].type).toBe(line.type);
    }
  });

  it('leaves unchanged lines as a single same part', () => {
    expect(lineDiffWithWords('a\nb', 'a\nb')).toEqual([
      { type: 'same', parts: [{ type: 'same', text: 'a' }] },
      { type: 'same', parts: [{ type: 'same', text: 'b' }] },
    ]);
  });

  it('keeps every line exactly once when deletions and insertions are unequal', () => {
    // Three deleted lines against one inserted line, all mutually dissimilar
    // (no shared words), so lineDiff emits the three dels before the single
    // add. Only the first del pairs with the add (pairs = min(3, 1) = 1); the
    // pair is below the similarity threshold, so both fall back to
    // whole-line. The two leftover dels are appended after. Every one of the
    // four original lines must appear exactly once.
    expect(lineDiffWithWords('apple\nbanana\ncherry', 'zebra')).toEqual([
      { type: 'del', parts: [{ type: 'del', text: 'apple' }] },
      { type: 'add', parts: [{ type: 'add', text: 'zebra' }] },
      { type: 'del', parts: [{ type: 'del', text: 'banana' }] },
      { type: 'del', parts: [{ type: 'del', text: 'cherry' }] },
    ]);
  });

  it('detects a changed run bordered by unchanged lines on both sides', () => {
    // Every other test here is either entirely changed or entirely
    // unchanged. This one has a same line before and after the changed run,
    // to exercise where the run starts and stops.
    expect(lineDiffWithWords('before\nchanged old\nafter', 'before\nchanged new\nafter')).toEqual([
      { type: 'same', parts: [{ type: 'same', text: 'before' }] },
      {
        type: 'del',
        parts: [
          { type: 'same', text: 'changed ' },
          { type: 'del', text: 'old' },
        ],
      },
      {
        type: 'add',
        parts: [
          { type: 'same', text: 'changed ' },
          { type: 'add', text: 'new' },
        ],
      },
      { type: 'same', parts: [{ type: 'same', text: 'after' }] },
    ]);
  });

  it('word diffs a pair sitting exactly on the similarity threshold', () => {
    // similarity() is shared-word-count / max(word-count), and the compare is
    // `>=`, so 0.3 itself must take the word-diff branch, not whole-line.
    // 'a b c d e f g h i j' has 10 words; 'a b c' has 3, all of which are
    // shared. shared / max(10, 3) = 3 / 10 = 0.3 exactly (3/10 === 0.3 in
    // IEEE 754, same rounding as the 0.3 literal). Because 'a b c' is a
    // literal prefix of the other line, wordDiff finds nothing new on the
    // insertion side: the whole new line is the shared prefix, so its parts
    // are same-only, and the old line's parts split into the shared prefix
    // plus everything deleted after it.
    expect(lineDiffWithWords('a b c d e f g h i j', 'a b c')).toEqual([
      {
        type: 'del',
        parts: [
          { type: 'same', text: 'a b c' },
          { type: 'del', text: ' d e f g h i j' },
        ],
      },
      {
        type: 'add',
        parts: [{ type: 'same', text: 'a b c' }],
      },
    ]);
  });
});
