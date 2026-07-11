import { describe, expect, it } from 'vitest';
import { ogCardVersion } from './version.js';

describe('ogCardVersion', () => {
  it('is stable for the same inputs', () => {
    const parts = ['Reforming the NCL Framework', 2, 'Will Norris', null, null];
    expect(ogCardVersion(parts)).toBe(ogCardVersion([...parts]));
  });

  it('changes when the resolved author name changes (the address->name case)', () => {
    const before = ogCardVersion(['Reforming the NCL Framework', 2, 'drep1ytuufvd6may…', null, null]);
    const after = ogCardVersion(['Reforming the NCL Framework', 2, 'Will Norris', null, null]);
    expect(before).not.toBe(after);
  });

  it('changes when the reply count, title, avatar hash or gov status change', () => {
    const base = ['Title', 2, 'Author', 'hashA', 'active'] as const;
    expect(ogCardVersion([...base])).not.toBe(ogCardVersion(['Title', 3, 'Author', 'hashA', 'active']));
    expect(ogCardVersion([...base])).not.toBe(ogCardVersion(['Other', 2, 'Author', 'hashA', 'active']));
    expect(ogCardVersion([...base])).not.toBe(ogCardVersion(['Title', 2, 'Author', 'hashB', 'active']));
    expect(ogCardVersion([...base])).not.toBe(ogCardVersion(['Title', 2, 'Author', 'hashA', 'enacted']));
  });

  it('treats null/undefined as empty and does not merge adjacent parts', () => {
    // ["ab", null] must not collide with ["a", "b"] or ["ab", ""].
    expect(ogCardVersion(['ab', null])).not.toBe(ogCardVersion(['a', 'b']));
    expect(ogCardVersion([undefined, 'x'])).toBe(ogCardVersion([null, 'x']));
  });

  it('is URL-safe (base36 only)', () => {
    expect(ogCardVersion(['Any title', 5, 'Name', 'hash', 'active'])).toMatch(/^[0-9a-z]+$/);
  });
});
