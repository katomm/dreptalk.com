// Drift guard: the cadences in the FRESHNESS array live in two hand-maintained
// places (see freshness.ts). The public /help/data-freshness page does not
// render FRESHNESS; it carries its own markdown copy of the table in
// src/content/guides/data-freshness.md. Nothing fails loudly when the two
// diverge, so a cadence edited in one place but not the other ships a guide that
// lies about the actual behavior. This test reads the markdown table and asserts
// every row matches FRESHNESS (label, refresh, notes; in order), so a mismatch
// fails CI instead of silently misinforming readers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { FRESHNESS } from './freshness.js';

const GUIDE_MD = fileURLToPath(
  new URL('../content/guides/data-freshness.md', import.meta.url),
);

// Parse the GitHub-flavored markdown table into rows of trimmed cells. Table
// rows are the lines that start with '|'; the header and the '|---|' separator
// are dropped. A leading/trailing pipe produces empty edge cells, so filter
// those out. A light parser is enough: the guide has exactly one such table.
function parseMarkdownTable(md: string): string[][] {
  const rows = md
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const header = rows[0];
  const separator = rows[1];
  // Sanity-check the table shape so a restructured guide fails here loudly
  // rather than silently parsing zero rows and passing.
  expect(header).toEqual(['Data', 'Refresh', 'Notes']);
  expect(separator.every((cell) => /^-+$/.test(cell))).toBe(true);
  return rows.slice(2);
}

describe('data-freshness guide table', () => {
  const md = readFileSync(GUIDE_MD, 'utf8');
  const tableRows = parseMarkdownTable(md);

  it('has one markdown row per FRESHNESS entry', () => {
    expect(tableRows.length).toBe(FRESHNESS.length);
  });

  it('matches the FRESHNESS array row for row', () => {
    const expected = FRESHNESS.map((row) => [row.label, row.refresh, row.notes]);
    expect(tableRows).toEqual(expected);
  });
});
