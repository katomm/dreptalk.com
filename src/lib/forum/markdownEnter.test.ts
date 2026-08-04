import { describe, it, expect } from 'vitest';
import { continueList } from './markdownEnter.js';

// Render the resulting selection with a | caret marker so assertions read
// clearly (all continuation results are collapsed carets).
function show(state: { text: string; start: number; end: number }): string {
  const { text, start } = state;
  return `${text.slice(0, start)}|${text.slice(start)}`;
}

// Caret helper: position is marked with | in the input string.
function at(withCaret: string): { text: string; start: number; end: number } {
  const start = withCaret.indexOf('|');
  const text = withCaret.replace('|', '');
  return { text, start, end: start };
}

describe('continueList: unordered', () => {
  it('continues a - bullet on Enter', () => {
    const out = continueList(at('- one|'));
    expect(show(out!)).toBe('- one\n- |');
  });

  it('continues a * bullet', () => {
    expect(continueList(at('* one|'))!.text).toBe('* one\n* ');
  });

  it('continues a + bullet', () => {
    expect(continueList(at('+ one|'))!.text).toBe('+ one\n+ ');
  });

  it('preserves indentation', () => {
    expect(continueList(at('  - one|'))!.text).toBe('  - one\n  - ');
  });

  it('preserves the exact spacing after the bullet', () => {
    expect(continueList(at('-   one|'))!.text).toBe('-   one\n-   ');
  });

  it('splits at the caret mid-content', () => {
    const out = continueList(at('- onetwo|three'));
    expect(show(out!)).toBe('- onetwo\n- |three');
  });
});

describe('continueList: task-list syntax is treated as a plain bullet', () => {
  // The Markdown renderer strips the checkbox <input> during sanitization, so
  // "- [ ]" is never a real checkbox. Continuation carries the plain bullet only
  // and leaves the "[ ]" as ordinary content.
  it('continues a "- [ ]" line as an ordinary bullet', () => {
    expect(continueList(at('- [ ] todo|'))!.text).toBe('- [ ] todo\n- ');
  });

  it('does the same for a "- [x]" line', () => {
    expect(continueList(at('- [x] done|'))!.text).toBe('- [x] done\n- ');
  });
});

describe('continueList: ordered', () => {
  it('increments the number', () => {
    const out = continueList(at('1. one|'));
    expect(show(out!)).toBe('1. one\n2. |');
  });

  it('keeps counting past single digits', () => {
    expect(continueList(at('9. nine|'))!.text).toBe('9. nine\n10. ');
  });

  it('supports the ) delimiter', () => {
    expect(continueList(at('1) one|'))!.text).toBe('1) one\n2) ');
  });

  it('preserves indentation and spacing', () => {
    expect(continueList(at('  3.  three|'))!.text).toBe('  3.  three\n  4.  ');
  });
});

describe('continueList: ending the list', () => {
  it('clears an empty unordered item', () => {
    const out = continueList(at('- one\n- |'));
    expect(show(out!)).toBe('- one\n|');
  });

  it('clears an empty ordered item', () => {
    const out = continueList(at('1. one\n2. |'));
    expect(show(out!)).toBe('1. one\n|');
  });
});

describe('continueList: not applicable', () => {
  it('returns null on a plain line', () => {
    expect(continueList(at('just text|'))).toBeNull();
  });

  it('returns null for a range selection', () => {
    expect(continueList({ text: '- one', start: 2, end: 5 })).toBeNull();
  });

  it('returns null when the caret is inside the marker of a non-empty item', () => {
    // Caret between "-" and the space, item has content -> plain newline.
    expect(continueList({ text: '- one', start: 1, end: 1 })).toBeNull();
  });

  it('does not treat a numbered sentence without a delimiter as a list', () => {
    expect(continueList(at('1 apple|'))).toBeNull();
  });
});
