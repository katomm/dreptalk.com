import { describe, it, expect } from 'vitest';
import { linkDisplayLabel } from './linkLabel.js';

describe('linkDisplayLabel', () => {
  it('uses the label when present', () => {
    expect(linkDisplayLabel({ label: 'My Site', uri: 'https://example.com/x' })).toBe('My Site');
  });
  it('falls back to the host when the label is empty', () => {
    expect(linkDisplayLabel({ label: '', uri: 'https://www.example.com/x' })).toBe('example.com');
  });
  it('falls back to the raw uri when it does not parse', () => {
    expect(linkDisplayLabel({ label: '', uri: 'not a url' })).toBe('not a url');
  });
});
