import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { factCheckEdition, parseShown, shownMatches } from './factCheck.js';
import { readEditionFile, readEditionDir } from './editionFiles.js';
import { actionRowSchema } from './schema.js';

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
  it('flags the social figure against its own source', () => {
    expect(messages('fact-source-mismatch')).toEqual(expect.arrayContaining([expect.stringContaining('ogFigure')]));
  });
  it('flags the invented count 4,321 and the invented 3', () => {
    expect(messages('number-not-in-pack')).toEqual(expect.arrayContaining([expect.stringContaining('4,321'), expect.stringContaining('"3"')]));
  });
  it('names the paragraph a number came from', () => {
    expect(messages('number-not-in-pack').find((m) => m.includes('4,321'))).toContain('paragraph 2');
  });
  it('flags the invented number inside a chart caption', () => {
    expect(messages('number-not-in-pack')).toEqual(expect.arrayContaining([expect.stringContaining('8,765')]));
    expect(messages('number-not-in-pack').find((m) => m.includes('8,765'))).toContain('chart 2 caption');
  });
  it('compares the action rows with the pack', () => {
    const m = messages('action-row-mismatch');
    expect(m.some((x) => x.includes('is not the pack title'))).toBe(true);
    expect(m.some((x) => x.includes('is not the pack status'))).toBe(true);
    expect(m.some((x) => x.includes('is not an event epoch'))).toBe(true);
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
  it('flags the two dashes and the semicolon', () => {
    expect(messages('forbidden-phrasing').length).toBe(3);
    expect(messages('forbidden-phrasing')).toEqual(expect.arrayContaining([expect.stringContaining('chart 2 caption')]));
  });
});

describe('an alias is no escape hatch', () => {
  it('rejects an alias that carries a number', () => {
    const row = { id: `${'a'.repeat(64)}#0`, title: 'T', type: 'InfoAction', outcome: 'open', epoch: 1, drepYesPct: null };
    expect(actionRowSchema.safeParse({ ...row, aliases: ['the 4,321 vote landslide'] }).success).toBe(false);
    expect(actionRowSchema.safeParse({ ...row, aliases: ['the committee update'] }).success).toBe(true);
  });
  it('keeps an alias link text in the scanned prose', () => {
    const g = load('good');
    const body = g.body.replace('[Update Constitutional Committee 2026]', '[the committee update for Fantasia]');
    const fm = { ...g.frontmatter, openActions: [{ ...g.frontmatter.openActions[0], aliases: ['the committee update for Fantasia'] }] };
    const rules = factCheckEdition({ ...g, frontmatter: fm, body }).map((f) => f.rule);
    expect(rules).not.toContain('link-not-in-pack');
    expect(rules).toContain('name-not-in-pack');
  });
});

describe('factCheckEdition on the good fixture', () => {
  it('has no findings', () => expect(factCheckEdition(load('good'))).toEqual([]));
  it('passes a body link in the CIP-129 form govActionHref emits', () => {
    const g = load('good');
    expect(g.body).toContain('/ga/729daaf2f9f89f842a61f6e3ebf7e57d16d6fa4116e29c13114780cb3909085000/');
    expect(factCheckEdition(g)).toEqual([]);
  });
  it('fails when the CIP-129 link points at a different action', () => {
    const g = load('good');
    const body = g.body.replace(
      '/ga/729daaf2f9f89f842a61f6e3ebf7e57d16d6fa4116e29c13114780cb3909085000/',
      '/ga/729daaf2f9f89f842a61f6e3ebf7e57d16d6fa4116e29c13114780cb3909085001/',
    );
    expect(factCheckEdition({ ...g, body }).map((f) => f.rule)).toContain('link-not-in-pack');
  });
  it('fails when the link text of a verified action is manipulated', () => {
    const g = load('good');
    const body = g.body.replace('[Update Constitutional Committee 2026]', '[Update Constitutional Committee 2027]');
    expect(factCheckEdition({ ...g, body }).map((f) => f.rule)).toContain('link-not-in-pack');
  });
  const withBody = (find: string, replace: string) => {
    const g = load('good');
    return factCheckEdition({ ...g, body: g.body.replace(find, replace) }).map((f) => f.rule);
  };
  it('flags an outcome verb behind any auxiliary, or none', () => {
    expect(withBody('stood at', 'passed and stood at')).toContain('closing-outcome-stated');
    expect(withBody('stood at', 'has now been enacted and stood at')).toContain('closing-outcome-stated');
  });
  it('flags a closing action the body never links', () => {
    const g = load('good');
    const body = '## As of the close\n\nNothing to report as of the close.\n';
    expect(factCheckEdition({ ...g, body }).map((f) => f.rule)).toEqual(['closing-not-linked']);
  });
  it('holds an open row to the expiry epoch, not to any event epoch', () => {
    const g = load('good');
    // An action submitted inside the window and still running: it has an event
    // epoch the page would never print, because an open row renders as a close.
    const pack = JSON.parse(JSON.stringify(g.pack)) as { actions: { events: unknown[] } };
    const id = `${'b'.repeat(64)}#0`;
    pack.actions.events.push({
      id, url: `/ga/${id}/`, type: 'InfoAction', title: 'Still running', status: 'active',
      expiryEpoch: 656, open: true, eventsInWindow: [{ kind: 'submitted', epoch: 651 }],
      tally: { drep: { yesPct: null } },
    });
    const row = { id, title: 'Still running', aliases: [], type: 'InfoAction', outcome: 'open' as const, epoch: 651, drepYesPct: null };
    const loose = factCheckEdition({ ...g, pack, frontmatter: { ...g.frontmatter, openActions: [...g.frontmatter.openActions, row] } });
    expect(loose.map((f) => f.message)).toEqual([expect.stringContaining('is not the pack expiry epoch (656)')]);
    const strict = factCheckEdition({ ...g, pack, frontmatter: { ...g.frontmatter, openActions: [...g.frontmatter.openActions, { ...row, epoch: 656 }] } });
    expect(strict).toEqual([]);
  });
  it('requires the link for a closing action listed under "Also decided" too', () => {
    const g = load('good');
    const frontmatter = { ...g.frontmatter, openActions: [], alsoDecided: g.frontmatter.openActions };
    const body = '## As of the close\n\nNothing to report as of the close.\n';
    expect(factCheckEdition({ ...g, frontmatter, body }).map((f) => f.rule)).toEqual(['closing-not-linked']);
  });
  it('scans headings for unknown names', () => {
    const rules = withBody('## As of the close', '## Fantasia at the close');
    expect(rules).toContain('name-not-in-pack');
  });
  it('scans the standfirst for numbers and phrasing', () => {
    const g = load('good');
    const frontmatter = { ...g.frontmatter, standfirst: 'A window of 4,321 votes — as the pack never said' };
    const findings = factCheckEdition({ ...g, frontmatter });
    expect(findings.map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringContaining('4,321'), expect.stringContaining('typographic dash (standfirst)')]));
  });
  it('reads an ISO date and an epoch range as neither claim nor negative number', () => {
    expect(withBody('at the start of epoch 650', 'on 2026-09-06, over epochs 650-652,')).toEqual([]);
  });
  it('still sees a chart fence with trailing spaces on its opening line', () => {
    const g = load('good');
    const body = g.body.replace('```chart\n', '```chart  \n').replace('1341.1', '9999.9');
    expect(factCheckEdition({ ...g, body }).map((f) => f.rule)).toEqual(['chart-source-mismatch']);
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
