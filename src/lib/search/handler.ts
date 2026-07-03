/// <reference types="@cloudflare/workers-types" />
// The search handler: validation, identifier fast-path, grouped full text, and
// scoped pagination for the /search page. Fails closed: any D1 error (including
// "no such table" during the window between a deploy and the manual migration
// apply) degrades to empty groups with a 200, so the palette's static entries
// keep working.
import { buildMatch } from './match.js';
import { detectIdentifier } from './identifiers.js';
import {
  resolveIdentifier,
  searchAll,
  countScopes,
  searchForumPage,
  searchGovernancePage,
  searchDrepsPage,
  type ExactHit,
  type GaHit,
  type TopicHit,
  type DrepHit,
  type ScopeCounts,
} from '../db/search.js';
import type { ApiScope } from './scopes.js';

export interface SearchResponseBody {
  query: string;
  scope: ApiScope;
  page: number;
  exact: ExactHit | null;
  governanceActions: GaHit[];
  discussions: TopicHit[];
  dreps: DrepHit[];
  total: number | null;
  counts: ScopeCounts | null;
}

export interface SearchOptions {
  scope?: ApiScope;
  page?: number;
  counts?: boolean;
}

const MAX_QUERY_LENGTH = 120;
const MIN_QUERY_LENGTH = 2;

function empty(query: string, scope: ApiScope, page: number, total: number | null): SearchResponseBody {
  return { query, scope, page, exact: null, governanceActions: [], discussions: [], dreps: [], total, counts: null };
}

/** Normalizes the raw q param: trim, collapse whitespace, cap length. */
export function normalizeQuery(raw: string | null): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
}

export async function handleSearch(db: D1Database, rawQuery: string | null, opts: SearchOptions = {}): Promise<SearchResponseBody> {
  const scope = opts.scope ?? 'all';
  const page = Math.max(1, opts.page ?? 1);
  const query = normalizeQuery(rawQuery);
  // Scoped queries report a numeric total; "all" leaves it null.
  const scopedTotal = scope === 'all' ? null : 0;
  if (query.length < MIN_QUERY_LENGTH) return empty(query, scope, page, scopedTotal);

  try {
    const match = buildMatch(query);
    if (!match) return empty(query, scope, page, scopedTotal);
    const counts = opts.counts ? await countScopes(db, match) : null;

    if (scope === 'governance') {
      const { hits, total } = await searchGovernancePage(db, match, page);
      return { ...empty(query, scope, page, total), governanceActions: hits, counts };
    }
    if (scope === 'dreps') {
      const { hits, total } = await searchDrepsPage(db, match, page);
      return { ...empty(query, scope, page, total), dreps: hits, counts };
    }
    if (scope === 'forum') {
      const { hits, total } = await searchForumPage(db, match, page);
      return { ...empty(query, scope, page, total), discussions: hits, counts };
    }

    // scope === 'all': exact fast path plus the grouped typeahead results.
    const ident = detectIdentifier(query);
    if (ident) {
      const exact = await resolveIdentifier(db, ident);
      if (exact) return { ...empty(query, scope, page, null), exact, counts };
    }
    const groups = await searchAll(db, match);
    return { ...empty(query, scope, page, null), ...groups, counts };
  } catch {
    return empty(query, scope, page, scopedTotal);
  }
}
