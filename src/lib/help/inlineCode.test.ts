import { describe, expect, it } from 'vitest';
import { splitInlineCode, stripInlineCode } from './inlineCode.js';

describe('splitInlineCode', () => {
  it('marks backtick spans as code', () => {
    expect(splitInlineCode('Add it to `body.references` early.')).toEqual([
      { text: 'Add it to ', code: false },
      { text: 'body.references', code: true },
      { text: ' early.', code: false },
    ]);
  });

  it('returns plain text as one part', () => {
    expect(splitInlineCode('No code here.')).toEqual([{ text: 'No code here.', code: false }]);
  });

  it('leaves a lone backtick as text', () => {
    expect(splitInlineCode('a ` b')).toEqual([{ text: 'a ` b', code: false }]);
  });

  it('keeps markup characters as text', () => {
    expect(splitInlineCode('`<b>`')).toEqual([{ text: '<b>', code: true }]);
  });
});

describe('stripInlineCode', () => {
  it('drops the backticks and keeps the text', () => {
    expect(stripInlineCode('Use `dreptalk.com/ga/` plus the `drep1` id.')).toBe(
      'Use dreptalk.com/ga/ plus the drep1 id.',
    );
  });
});
