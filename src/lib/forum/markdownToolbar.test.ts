import { describe, it, expect } from 'vitest';
import { applyMarkdown } from './markdownToolbar.js';

// Helper: render the resulting selection as a string with | markers so the
// expected cursor/selection is easy to read in assertions.
function show(state: { text: string; start: number; end: number }): string {
  const { text, start, end } = state;
  return `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;
}

describe('applyMarkdown: inline wrap (bold)', () => {
  it('wraps a selection in **', () => {
    const out = applyMarkdown({ text: 'hello world', start: 6, end: 11 }, 'bold');
    expect(out.text).toBe('hello **world**');
    expect(show(out)).toBe('hello **[world]**');
  });

  it('inserts empty markers and places the cursor inside when nothing is selected', () => {
    const out = applyMarkdown({ text: 'hello ', start: 6, end: 6 }, 'bold');
    expect(out.text).toBe('hello ****');
    expect(out.start).toBe(8);
    expect(out.end).toBe(8);
  });

  it('toggles off when the selection is already bold', () => {
    const out = applyMarkdown({ text: 'hello **world**', start: 8, end: 13 }, 'bold');
    expect(out.text).toBe('hello world');
    expect(show(out)).toBe('hello [world]');
  });
});

describe('applyMarkdown: inline wrap (italic, code)', () => {
  it('wraps italic in single *', () => {
    const out = applyMarkdown({ text: 'a word', start: 2, end: 6 }, 'italic');
    expect(out.text).toBe('a *word*');
  });

  it('wraps inline code in backticks', () => {
    const out = applyMarkdown({ text: 'run npm test', start: 4, end: 12 }, 'code');
    expect(out.text).toBe('run `npm test`');
  });

  it('toggles italic off without touching surrounding bold', () => {
    const out = applyMarkdown({ text: '*word*', start: 1, end: 5 }, 'italic');
    expect(out.text).toBe('word');
  });
});

describe('applyMarkdown: strikethrough', () => {
  it('wraps a selection in ~~', () => {
    const out = applyMarkdown({ text: 'a word', start: 2, end: 6 }, 'strike');
    expect(out.text).toBe('a ~~word~~');
    expect(show(out)).toBe('a ~~[word]~~');
  });

  it('toggles strikethrough off', () => {
    const out = applyMarkdown({ text: '~~word~~', start: 2, end: 6 }, 'strike');
    expect(out.text).toBe('word');
  });
});

describe('applyMarkdown: ordered list', () => {
  it('numbers every line in the selection', () => {
    const out = applyMarkdown({ text: 'one\ntwo\nthree', start: 0, end: 13 }, 'orderedList');
    expect(out.text).toBe('1. one\n2. two\n3. three');
  });

  it('numbers a single line the cursor sits on', () => {
    const out = applyMarkdown({ text: 'a line', start: 3, end: 3 }, 'orderedList');
    expect(out.text).toBe('1. a line');
  });

  it('toggles numbering off when every line is already numbered', () => {
    const out = applyMarkdown({ text: '1. one\n2. two\n3. three', start: 0, end: 22 }, 'orderedList');
    expect(out.text).toBe('one\ntwo\nthree');
  });
});

describe('applyMarkdown: link', () => {
  it('turns a selection into link text and selects the url placeholder', () => {
    const out = applyMarkdown({ text: 'see docs', start: 4, end: 8 }, 'link');
    expect(out.text).toBe('see [docs](url)');
    expect(show(out)).toBe('see [docs]([url])');
  });

  it('inserts a full template and selects the text placeholder when empty', () => {
    const out = applyMarkdown({ text: '', start: 0, end: 0 }, 'link');
    expect(out.text).toBe('[text](url)');
    expect(show(out)).toBe('[[text]](url)');
  });
});

describe('applyMarkdown: line prefixes (quote, list, heading)', () => {
  it('prefixes a single line with > for quote', () => {
    const out = applyMarkdown({ text: 'a line', start: 0, end: 6 }, 'quote');
    expect(out.text).toBe('> a line');
  });

  it('prefixes every line in the selection with - for list', () => {
    const out = applyMarkdown({ text: 'one\ntwo\nthree', start: 0, end: 13 }, 'list');
    expect(out.text).toBe('- one\n- two\n- three');
  });

  it('prefixes with ## for heading', () => {
    const out = applyMarkdown({ text: 'Title', start: 0, end: 5 }, 'heading');
    expect(out.text).toBe('## Title');
  });

  it('toggles a line prefix off when every line already has it', () => {
    const out = applyMarkdown({ text: '- one\n- two', start: 0, end: 11 }, 'list');
    expect(out.text).toBe('one\ntwo');
  });

  it('expands a collapsed cursor to cover the whole line it sits on', () => {
    const out = applyMarkdown({ text: 'hello world', start: 3, end: 3 }, 'quote');
    expect(out.text).toBe('> hello world');
  });
});
