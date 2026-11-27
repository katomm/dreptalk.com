import { describe, it, expect } from 'vitest';
import { impactNote } from './impactNote.js';

describe('impactNote', () => {
  it('names the basis epoch only for a decided proposal, and the pool data only when it was used', () => {
    for (const withPools of [true, false]) {
      const open = impactNote('open', withPools, null);
      const enacted = impactNote('enacted', withPools, 613);
      const ended = impactNote('ended', withPools, 612);
      expect(open).toContain('current');
      expect(open).not.toMatch(/epoch/);
      expect(impactNote('open', withPools, 613)).toBe(open);
      expect(enacted).toContain('epoch 613');
      expect(ended).toContain('epoch 612');
      // Three distinct outcomes, three distinct sentences.
      expect(new Set([open, enacted, ended]).size).toBe(3);
      for (const note of [open, enacted, ended]) expect(note.includes('pool distribution')).toBe(withPools);
    }
  });

  it('falls back to the open sentences without an epoch', () => {
    expect(impactNote('enacted', true, null)).toBe(impactNote('open', true, null));
    expect(impactNote('ended', false, null)).toBe(impactNote('open', false, null));
  });
});
