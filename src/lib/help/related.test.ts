import { describe, expect, it } from 'vitest';
import { splitAtRelated } from './related.js';

describe('splitAtRelated', () => {
  it('splits in front of the Related heading', () => {
    const html = '<p>Intro</p>\n<h2 id="related">Related</h2>\n<ul><li>x</li></ul>';
    expect(splitAtRelated(html)).toEqual({
      body: '<p>Intro</p>\n',
      related: '<h2 id="related">Related</h2>\n<ul><li>x</li></ul>',
    });
  });

  it('keeps the whole guide as body without a Related heading', () => {
    expect(splitAtRelated('<p>Intro</p>')).toEqual({ body: '<p>Intro</p>', related: '' });
  });

  it('does not split at headings that only start with Related', () => {
    const html = '<h2 id="related-actions">Related actions</h2><p>x</p>';
    expect(splitAtRelated(html).related).toBe('');
  });
});
