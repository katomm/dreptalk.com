// Every guide ships three renditions of its illustration, all derived from one
// master by scripts/generate-help-illustrations.mjs. Nothing regenerates them at
// build time, so a new guide added without running `npm run assets:help` would
// otherwise reach production with a broken header image, an empty index card, or
// a text-only OG card, and none of that shows up in a type check or a page test.
// These run against the real files, like the font coverage tests do.
//
// One test per rendition rather than one per guide: each collects every slug it
// is missing, so a failure names all of them at once instead of stopping at the
// first, and the suite stays four cases instead of one per guide.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(import.meta.dirname, '../../..');
const guidesDir = path.join(root, 'src/content/guides');

const slugs = readdirSync(guidesDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort();

/** Slugs whose file at `pathFor` is missing or empty (an empty file still renders broken). */
const missing = (pathFor: (slug: string) => string): string[] =>
  slugs.filter((slug) => {
    const p = path.join(root, pathFor(slug));
    return !existsSync(p) || statSync(p).size === 0;
  });

const FIX = 'run: npm run assets:help';

describe('help illustrations', () => {
  it('has guides to check', () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  it('derives every rendition from a master', () => {
    expect(missing((s) => `assets/help-illustrations/${s}.webp`), 'guides with no master illustration').toEqual([]);
  });

  it('ships each rendition for every guide', () => {
    expect(missing((s) => `public/help/${s}.webp`), `guide header (360px), ${FIX}`).toEqual([]);
    expect(missing((s) => `public/help/cards/${s}.webp`), `index card (192px), ${FIX}`).toEqual([]);
    expect(missing((s) => `public/help/og/${s}.png`), `OG card (480px), ${FIX}`).toEqual([]);
  });

  it('ships no rendition for a guide that no longer exists', () => {
    const known = new Set(slugs);
    const orphans = readdirSync(path.join(root, 'public/help/cards'))
      .filter((f) => f.endsWith('.webp'))
      .map((f) => f.replace(/\.webp$/, ''))
      .filter((s) => !known.has(s));
    expect(orphans).toEqual([]);
  });
});
