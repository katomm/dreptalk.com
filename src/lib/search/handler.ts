/// <reference types="@cloudflare/workers-types" />
// The search handler: validation, identifier fast-path, grouped full text.
// Fails closed: any D1 error (including "no such table" during the window
// between a deploy and the manual migration apply) degrades to empty groups
// with a 200, so the palette's static entries keep working.
import { buildMatch } from './match.js';
import { detectIdentifier } from './identifiers.js';
import { resolveIdentifier, searchAll, type ExactHit, type GaHit, type TopicHit, type DrepHit } from '../db/search.js';

export interface SearchResponseBody {
  query: string;
  exact: ExactHit | null;
  governanceActions: GaHit[];
  discussions: TopicHit[];
  dreps: DrepHit[];
}

const MAX_QUERY_LENGTH = 120;
const MIN_QUERY_LENGTH = 2;

function empty(query: string): SearchResponseBody {
  return { query, exact: null, governanceActions: [], discussions: [], dreps: [] };
}

/** Normalizes the raw q param: trim, collapse whitespace, cap length. */
export function normalizeQuery(raw: string | null): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
}

export async function handleSearch(db: D1Database, rawQuery: string | null): Promise<SearchResponseBody> {
  const query = normalizeQuery(rawQuery);
  if (query.length < MIN_QUERY_LENGTH) return empty(query);

  try {
    const ident = detectIdentifier(query);
    if (ident) {
      const exact = await resolveIdentifier(db, ident);
      if (exact) return { ...empty(query), exact };
    }
    const match = buildMatch(query);
    if (!match) return empty(query);
    const groups = await searchAll(db, match);
    return { query, exact: null, ...groups };
  } catch {
    return empty(query);
  }
}
