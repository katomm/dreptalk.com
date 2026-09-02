import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// The movers board is screenshotted by an external routine, which clips this
// selector. Class names are free to change, this attribute is not: without it
// the routine would silently photograph the wrong region.
test('the movers board carries its screenshot anchor', () => {
  const source = readFileSync(new URL('../movers.astro', import.meta.url), 'utf8');
  expect(source).toContain('data-screenshot="movers-board"');
});
