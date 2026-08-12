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

  it('zips several changed lines inside one run', () => {
    const out = lineDiffWithWords('one alpha\ntwo beta', 'one gamma\ntwo delta');
    const marked = out.filter((l) => l.parts.some((p) => p.type !== 'same'));
    expect(marked).toHaveLength(4);
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
});
