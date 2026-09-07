// Collection access for the review pages. Server-only (astro:content), and the
// single place that maps a collection entry onto the window rules, so the pages,
// the sitemap, the OG route and the state endpoint cannot drift apart.
import { getCollection, type CollectionEntry } from 'astro:content';
import { buildEditionIndex, slugFor, type EditionIndex, type EditionSummary } from './windows.js';
import { epochStartMs, type NetworkConfig } from '../config/network.js';

export type Edition = CollectionEntry<'review'>;

/** Every published edition, newest window first. */
export async function loadEditions(): Promise<Edition[]> {
  const all = await getCollection('review');
  return all.sort((a, b) => b.data.epochFrom - a.data.epochFrom);
}

export function editionSummary(e: Edition): EditionSummary {
  return {
    from: e.data.epochFrom,
    to: e.data.epochTo,
    featured: e.data.featuredActions,
    rows: [...e.data.alsoDecided, ...e.data.openActions].map((r) => r.id),
  };
}

export async function loadEditionIndex(): Promise<EditionIndex> {
  const all = await getCollection('review');
  return buildEditionIndex(all.map(editionSummary));
}

export function editionSlug(e: Edition): string {
  return slugFor(e.data.epochFrom, e.data.epochTo);
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "17 Aug 2026 to 1 Sept 2026": the window's first boundary and the boundary that closes it. */
export function formatWindowDates(from: number, to: number, cfg: NetworkConfig): string {
  return `${DATE.format(new Date(epochStartMs(from, cfg)))} to ${DATE.format(new Date(epochStartMs(to + 1, cfg)))}`;
}
