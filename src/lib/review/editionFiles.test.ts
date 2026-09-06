import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readEditionDir } from './editionFiles.js';
import { assertContiguous, slugFor } from './windows.js';

const CONTENT = path.join(import.meta.dirname, '../../content/review');

function fm(from: number, to: number): string {
  return `---
title: T
standfirst: S
epochFrom: ${from}
epochTo: ${to}
published: 2026-09-02
dataAsOf: "2026-09-02T06:10:00Z"
packVersion: 1
facts:
  - { value: "1", label: a, source: x }
  - { value: "1", label: b, source: x }
  - { value: "1", label: c, source: x }
  - { value: "1", label: d, source: x }
ogFigure: { value: "1", label: x }
numbers: { delegatedPowerStartAda: null, delegatedPowerEndAda: null, voteTransactions: null, finalDrepVoters: null, treasuryStartAda: null, treasuryEndAda: null }
---
body
`;
}

function checkDir(files: Array<[string, string]>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rv-'));
  for (const [name, content] of files) writeFileSync(path.join(dir, name), content);
  const editions = readEditionDir(dir);
  for (const e of editions) expect(e.slug, 'file name matches its window').toBe(slugFor(e.frontmatter.epochFrom, e.frontmatter.epochTo));
  assertContiguous(editions.map((e) => ({ from: e.frontmatter.epochFrom, to: e.frontmatter.epochTo })));
}

describe('edition files', () => {
  it('accepts a contiguous set', () => {
    expect(() => checkDir([['epochs-650-652.md', fm(650, 652)], ['epochs-653-655.md', fm(653, 655)]])).not.toThrow();
  });
  it('rejects a gap', () => {
    expect(() => checkDir([['epochs-650-652.md', fm(650, 652)], ['epochs-660-662.md', fm(660, 662)]])).toThrow('gap');
  });
  it('rejects an overlap', () => {
    expect(() => checkDir([['epochs-650-652.md', fm(650, 652)], ['epochs-652-654.md', fm(652, 654)]])).toThrow('overlap');
  });
  it('rejects a file whose name does not match its window', () => {
    expect(() => checkDir([['epochs-650-653.md', fm(650, 652)]])).toThrow('file name matches its window');
  });
  it('holds for the published editions', () => {
    const editions = readEditionDir(CONTENT);
    for (const e of editions) expect(e.slug).toBe(slugFor(e.frontmatter.epochFrom, e.frontmatter.epochTo));
    assertContiguous(editions.map((e) => ({ from: e.frontmatter.epochFrom, to: e.frontmatter.epochTo })));
  });
});
