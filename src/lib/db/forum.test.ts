import { describe, it, expect } from 'vitest';
import { slugify } from './forum.js';

describe('slugify', () => {
  it('lowercases and turns every non-alphanumeric run into one hyphen', () => {
    expect(slugify('Hello World!', 'abc')).toBe('hello-world-abc');
    expect(slugify('UPPERCASE Title', 'x1')).toBe('uppercase-title-x1');
    expect(slugify('foo---bar!!!baz', 'q1')).toBe('foo-bar-baz-q1');
  });

  it('strips leading and trailing hyphens from the base', () => {
    expect(slugify('  leading trailing  ', 'zz')).toBe('leading-trailing-zz');
  });

  it('caps the base at 60 characters before appending the suffix', () => {
    expect(slugify('a'.repeat(80), 'sfx')).toBe(`${'a'.repeat(60)}-sfx`);
  });

  it('drops a hyphen left at the end of the base by the cap', () => {
    // Character 60 is a separator, so the cut base would end in a hyphen.
    expect(slugify(`${'a'.repeat(59)} b`, 'sfx')).toBe(`${'a'.repeat(59)}-sfx`);
  });
});
