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

    // opts.counts has a dual role. Its primary job is to return facet counts
    // for the /search page. It also selects "page mode" vs the palette's
    // "typeahead mode" for scope === 'all' below: the page builds each group
    // from the scoped queries so its counts and results agree, while the
    // palette keeps the merged typeahead groups. The scoped modes are identical
    // in both, so they only vary the counts.
    const scopedCounts = opts.counts && scope !== 'all' ? await countScopes(db, match) : null;

    // Scoped modes: one entity, paginated. countScopes' per-scope totals equal
    // each scoped query's total, so the facet numbers match the result lists.
    if (scope === 'governance') {
      const { hits, total } = await searchGovernancePage(db, match, page);
      return { ...empty(query, scope, page, total), governanceActions: hits, counts: scopedCounts };
    }
    if (scope === 'dreps') {
      const { hits, total } = await searchDrepsPage(db, match, page);
      return { ...empty(query, scope, page, total), dreps: hits, counts: scopedCounts };
    }
    if (scope === 'forum') {
      const { hits, total } = await searchForumPage(db, match, page);
      return { ...empty(query, scope, page, total), discussions: hits, counts: scopedCounts };
    }

    // scope === 'all'. The exact fast path (pasted governance-action id / DRep
    // id) runs in both modes.
    const ident = detectIdentifier(query);
    const exact = ident ? await resolveIdentifier(db, ident) : null;

    if (opts.counts) {
      // Page mode (/search): build every group from the same scoped queries
      // that back the facets, so the "All" preview and the facet counts agree.
      const [gov, forum, dreps] = await Promise.all([
        searchGovernancePage(db, match, 1),
        searchForumPage(db, match, 1),
        searchDrepsPage(db, match, 1),
      ]);
      return {
        ...empty(query, scope, page, null),
        exact,
        governanceActions: gov.hits,
        discussions: forum.hits,
        dreps: dreps.hits,
        counts: { forum: forum.total, governance: gov.total, dreps: dreps.total },
      };
    }

    // Palette mode: the merged typeahead groups (discussion hits fold into the
    // governance group). No facet counts.
    if (exact) return { ...empty(query, scope, page, null), exact, counts: null };
    const groups = await searchAll(db, match);
    return { ...empty(query, scope, page, null), ...groups, counts: null };
  } catch {
    return empty(query, scope, page, scopedTotal);
  }
}
