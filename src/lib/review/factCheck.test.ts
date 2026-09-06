import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { factCheckEdition, parseShown, shownMatches } from './factCheck.js';
import { readEditionFile, readEditionDir } from './editionFiles.js';

const CONTENT = path.join(import.meta.dirname, '../../content/review');
const FIX = path.join(import.meta.dirname, '__fixtures__');
const load = (name: string) => {
  const { frontmatter, body } = readEditionFile(path.join(FIX, `${name}-edition.md`));
  return { frontmatter, body, pack: JSON.parse(readFileSync(path.join(FIX, `${name}-edition.pack.json`), 'utf8')) };
};

describe('parseShown and shownMatches', () => {
  it('keeps unit, sign and precision', () => {
    expect(parseShown('₳120M')).toEqual({ value: 120, unit: 'M', decimals: 0, negative: false });
    expect(parseShown('−232M')).toEqual({ value: 232, unit: 'M', decimals: 0, negative: true });
    expect(parseShown('69.9%')).toEqual({ value: 69.9, unit: '%', decimals: 1, negative: false });
    expect(parseShown('4,321')).toEqual({ value: 4321, unit: '', decimals: 0, negative: false });
  });
  it('matches only in the shown unit and precision', () => {
    expect(shownMatches(parseShown('₳120M')!, 120_000_000)).toBe(true);
    expect(shownMatches(parseShown('₳120M')!, 96_800_000)).toBe(false);
    expect(shownMatches(parseShown('₳96.8M')!, 96_800_000)).toBe(true);
    expect(shownMatches(parseShown('69.9%')!, 69.85)).toBe(true);
    expect(shownMatches(parseShown('69.9%')!, 69.94)).toBe(true);
    expect(shownMatches(parseShown('69.9%')!, 70.0)).toBe(false);
    expect(shownMatches(parseShown('4,321')!, 4321)).toBe(true);
    expect(shownMatches(parseShown('4,321')!, 4320.6)).toBe(false);
    expect(shownMatches(parseShown('7')!, 7)).toBe(true);
    expect(shownMatches(parseShown('7')!, 96_800_000)).toBe(false);
    expect(shownMatches(parseShown('−232M')!, -232_000_000)).toBe(true);
    expect(shownMatches(parseShown('−232M')!, 232_000_000)).toBe(false);
  });
});

describe('factCheckEdition on the bad fixture', () => {
  const findings = factCheckEdition(load('bad'));
  const rules = findings.map((f) => f.rule);
  const messages = (rule: string) => findings.filter((f) => f.rule === rule).map((f) => f.message);
  it('flags the fact whose source is 96.8M, not 120M', () => expect(rules).toContain('fact-source-mismatch'));
  it('flags the invented count 4,321 and the invented 3', () => {
    expect(messages('number-not-in-pack')).toEqual(expect.arrayContaining([expect.stringContaining('4,321'), expect.stringContaining('"3"')]));
  });
  it('flags the wrong derived value', () => expect(rules).toContain('derived-wrong'));
  it('reports the unquoted chart source as an invalid block with its number', () => {
    expect(messages('chart-invalid')).toEqual([expect.stringContaining('chart 1')]);
  });
  it('flags the chart whose epochs do not match its epoch source', () => {
    expect(messages('chart-source-mismatch').some((m) => m.startsWith('chart 2') && m.includes('epoch'))).toBe(true);
  });
  it('flags Fantasy DRep, Fantasia at a sentence start and the padded Yoroi name', () => {
    expect(messages('name-not-in-pack')).toEqual(expect.arrayContaining([expect.stringContaining('Fantasy DRep'), expect.stringContaining('Fantasia'), expect.stringContaining('Evil Yoroi Wallet')]));
  });
  it('flags the outcome stated for the linked closing action', () => expect(rules).toContain('closing-outcome-stated'));
  it('flags the dash and the semicolon', () => expect(messages('forbidden-phrasing').length).toBe(2));
});

describe('factCheckEdition on the good fixture', () => {
  it('has no findings', () => expect(factCheckEdition(load('good'))).toEqual([]));
  it('fails when the link text of a verified action is manipulated', () => {
    const g = load('good');
    const body = g.body.replace('[Update Constitutional Committee 2026]', '[Update Constitutional Committee 2027]');
    expect(factCheckEdition({ ...g, body }).map((f) => f.rule)).toContain('link-not-in-pack');
  });
});

// Skipped while src/content/review holds no edition yet, vitest rejects an empty suite.
const editions = readEditionDir(CONTENT);
describe.skipIf(editions.length === 0)('every published edition passes', () => {
  for (const e of editions) {
    it(e.slug, () => {
      const pack = JSON.parse(readFileSync(e.file.replace(/\.md$/, '.pack.json'), 'utf8'));
      expect(factCheckEdition({ frontmatter: e.frontmatter, body: e.body, pack })).toEqual([]);
    });
  }
});
