import { describe, expect, it } from 'vitest';
import { reviewMeta } from './meta.js';

describe('reviewMeta', () => {
  it('uses a single DRepTalk suffix', () => {
    expect(reviewMeta('Epochs 636 to 638: a headline', 'Short.').title).toBe('Epochs 636 to 638: a headline - DRepTalk');
  });

  it('keeps a short standfirst intact', () => {
    expect(reviewMeta('T', 'Short summary.').description).toBe('Short summary.');
  });

  it('clips a long standfirst to 155 characters on a word boundary', () => {
    const long = 'word '.repeat(70).trim();
    const { description } = reviewMeta('T', long);
    expect(Array.from(description).length).toBeLessThanOrEqual(155);
    expect(description.endsWith('...')).toBe(true);
    expect(description.slice(0, -3).split(' ').every((w) => w === 'word')).toBe(true);
  });
});
