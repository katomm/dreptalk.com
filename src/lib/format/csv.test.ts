import { describe, it, expect } from 'vitest';
import { csvField } from './csv.js';

describe('csvField', () => {
  it('leaves plain values untouched', () => {
    expect(csvField('Reduce minPoolCost')).toBe('Reduce minPoolCost');
  });

  it('quotes and escapes values with commas, quotes, or newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
});
