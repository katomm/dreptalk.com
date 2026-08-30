// The fallback gate reads its "what can we already draw" set straight off the
// shipped fonts, so these run against the real files in public/fonts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachedCoveredCodepoints, coveredCodepoints } from './fontCoverage.js';

const fonts = path.join(import.meta.dirname, '../../../public/fonts');
const read = (file: string): ArrayBuffer => {
  const buf = readFileSync(path.join(fonts, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};
const cp = (char: string): number => char.codePointAt(0) as number;

describe('coveredCodepoints', () => {
  it('reads the shipped Plus Jakarta Sans subset: ASCII and Latin-1, nothing beyond', () => {
    const covered = coveredCodepoints(read('plus-jakarta-sans-700.ttf'));
    for (const char of 'AZaz0123456789 .,-%öüéñ') expect(covered.has(cp(char))).toBe(true);
    // The subset stops short of Latin Extended-A, Cyrillic and every CJK block,
    // which is exactly why a name in those scripts needs a fallback face.
    for (const char of 'Łāй忠実한') expect(covered.has(cp(char))).toBe(false);
  });

  it('reads the one-glyph ada face', () => {
    const covered = coveredCodepoints(read('ada-symbol.ttf'));
    expect([...covered]).toEqual([cp('₳')]);
  });

  it('treats an unreadable font as covering nothing rather than throwing', () => {
    expect(coveredCodepoints(new Uint8Array([1, 2, 3, 4]).buffer).size).toBe(0);
    expect(coveredCodepoints(new ArrayBuffer(0)).size).toBe(0);
  });

  it('memoises per buffer', () => {
    const data = read('ada-symbol.ttf');
    expect(cachedCoveredCodepoints(data)).toBe(cachedCoveredCodepoints(data));
  });
});
