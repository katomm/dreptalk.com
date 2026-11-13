import { describe, expect, it } from 'vitest';
import {
  countWords,
  currentIndex,
  groupParticipants,
  indentLevel,
  lengthBarPx,
  MAP_MIN_POSTS,
  MAP_MIN_WORDS,
  pillHidden,
  shouldShowMap,
} from './threadMap.js';

describe('countWords', () => {
  it('is 0 for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });
  it('splits on runs of whitespace, newlines and non-breaking spaces', () => {
    expect(countWords('one  two\nthree four\t five')).toBe(5);
  });
});

describe('shouldShowMap', () => {
  it('needs enough posts or enough words', () => {
    expect(shouldShowMap(MAP_MIN_POSTS - 1, 100)).toBe(false);
    expect(shouldShowMap(MAP_MIN_POSTS, 100)).toBe(true);
    expect(shouldShowMap(4, MAP_MIN_WORDS - 1)).toBe(false);
    expect(shouldShowMap(4, MAP_MIN_WORDS)).toBe(true);
  });
});

describe('lengthBarPx', () => {
  it('is 0 for a post without words', () => {
    expect(lengthBarPx(0, 2600)).toBe(0);
  });
  it('gives the longest post the full width', () => {
    expect(lengthBarPx(2600, 2600)).toBe(36);
  });
  it('keeps a short post visible at the minimum width', () => {
    expect(lengthBarPx(1, 2600)).toBe(3);
  });
  it('scales by square root', () => {
    expect(lengthBarPx(650, 2600)).toBe(18);
  });
});

describe('indentLevel', () => {
  it('caps the reply depth at three levels', () => {
    expect(indentLevel(0)).toBe(0);
    expect(indentLevel(1)).toBe(1);
    expect(indentLevel(3)).toBe(3);
    expect(indentLevel(7)).toBe(3);
  });
});

describe('groupParticipants', () => {
  const post = (authorId: string, authorName: string) => ({ authorId, authorName });

  it('keeps authors with the same display name apart', () => {
    const result = groupParticipants([post('a', 'Sam'), post('b', 'Sam')]);
    expect(result.map((p) => p.authorId)).toEqual(['a', 'b']);
  });
  it('sorts by post count, ties by first appearance', () => {
    const result = groupParticipants([
      post('a', 'A'),
      post('b', 'B'),
      post('c', 'C'),
      post('c', 'C'),
      post('b', 'B'),
    ]);
    expect(result.map((p) => [p.authorId, p.count])).toEqual([
      ['b', 2],
      ['c', 2],
      ['a', 1],
    ]);
  });
});

describe('currentIndex', () => {
  const tops = [100, 500, 900];
  it('is the first post while the band is above it', () => {
    expect(currentIndex(tops, 80, false)).toBe(0);
  });
  it('counts a post whose top touches the band', () => {
    expect(currentIndex([-300, 80, 600], 80, false)).toBe(1);
  });
  it('is the last post that passed the band', () => {
    expect(currentIndex([-700, -200, 300], 80, false)).toBe(1);
  });
  it('is the last post at the end of the page', () => {
    expect(currentIndex([-700, -200, 300], 80, true)).toBe(2);
  });
  it('is -1 without posts', () => {
    expect(currentIndex([], 80, false)).toBe(-1);
    expect(currentIndex([], 80, true)).toBe(-1);
  });
});

describe('pillHidden', () => {
  const shown = { formFocused: false, postsEnd: 900, pillBottom: 800, overlapsForm: false };
  it('shows the pill while posts reach below it', () => {
    expect(pillHidden(shown)).toBe(false);
    expect(pillHidden({ ...shown, postsEnd: 800 })).toBe(false);
  });
  it('hides it once the posts end above its bottom edge', () => {
    expect(pillHidden({ ...shown, postsEnd: 799 })).toBe(true);
  });
  it('hides it while a text control has focus or a form sits under it', () => {
    expect(pillHidden({ ...shown, formFocused: true })).toBe(true);
    expect(pillHidden({ ...shown, overlapsForm: true })).toBe(true);
  });
});
