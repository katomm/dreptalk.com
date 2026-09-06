// Window rules of the Governance Review: derived slugs, the contiguity invariant
// over the published set, and the lookups the site needs (action id to edition,
// latest edition). Pure, no Astro imports, so node tests can use it directly.
export interface Window { from: number; to: number }

export function slugFor(from: number, to: number): string {
  return `epochs-${from}-${to}`;
}

export function parseSlug(slug: string): Window | null {
  const m = /^epochs-(\d+)-(\d+)$/.exec(slug);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (!(to > from)) return null;
  return { from, to };
}

/** Throws when the sorted windows leave a gap or overlap. Growth at either end is fine. */
export function assertContiguous(windows: readonly Window[]): void {
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.from === prev.to + 1) continue;
    const kind = cur.from <= prev.to ? 'overlap' : 'gap';
    throw new Error(`${kind} between ${slugFor(prev.from, prev.to)} and ${slugFor(cur.from, cur.to)}`);
  }
}

export interface EditionSummary extends Window {
  featured: readonly string[];
  rows: readonly string[];
}

export interface EditionIndex {
  byActionId: Map<string, string>;
  latest: string | null;
  lastCoveredEpoch: number | null;
}

export function buildEditionIndex(editions: readonly EditionSummary[]): EditionIndex {
  const sorted = [...editions].sort((a, b) => a.from - b.from);
  const byActionId = new Map<string, string>();
  const featuredIn = new Set<string>();
  for (const e of sorted) {
    const slug = slugFor(e.from, e.to);
    for (const id of e.rows) if (!featuredIn.has(id)) byActionId.set(id, slug);
    for (const id of e.featured) {
      byActionId.set(id, slug);
      featuredIn.add(id);
    }
  }
  const last = sorted.at(-1);
  return {
    byActionId,
    latest: last ? slugFor(last.from, last.to) : null,
    lastCoveredEpoch: last ? last.to : null,
  };
}
