// Palette entries for the Help group: guides plus glossary terms. The
// collections are immutable per deploy, so the list is built once per isolate
// and reused by every SSR render instead of being recomputed per request.
import { getCollection } from 'astro:content';
import type { HelpEntry } from './staticEntries.js';

let cached: HelpEntry[] | undefined;

export async function getHelpEntries(): Promise<HelpEntry[]> {
  if (!cached) {
    cached = [
      // Keywords carry only what the label and description (matched separately)
      // do not already cover: for guides that is the full page title.
      ...(await getCollection('guides')).map((g) => ({ label: g.data.cardLabel, href: `/help/${g.id}/`, keywords: g.data.title, description: g.data.description })),
      ...(await getCollection('glossary')).map((g) => ({ label: g.data.term, href: `/glossary/${g.id}/`, keywords: '', description: g.data.description })),
    ].sort((a, b) => a.label.localeCompare(b.label));
  }
  return cached;
}
