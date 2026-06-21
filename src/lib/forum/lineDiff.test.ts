import { describe, it, expect } from 'vitest';
import { lineDiff } from './lineDiff.js';

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
