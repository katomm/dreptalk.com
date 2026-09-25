import { describe, it, expect } from 'vitest';
import { effectiveDrepStatus } from './dreps.js';

describe('effectiveDrepStatus', () => {
  it('maps the active boolean to the two effective states', () => {
    expect(effectiveDrepStatus(true)).toBe('active');
    expect(effectiveDrepStatus(false)).toBe('inactive');
  });
});
