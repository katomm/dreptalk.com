/// <reference types="@cloudflare/workers-types" />
// The search handler: validation, identifier fast-path, grouped full text, and
// scoped pagination for the /search page. D1 answers the database-backed
// scopes, the in-memory content index answers help and the Governance Review.
// Fails closed: any D1 error (including "no such table" during the window
// between a deploy and the manual migration apply) degrades the D1 groups to
// empty with a 200, while the content groups keep working.
import { buildMatch } from './match.js';
import { detectIdentifier } from './identifiers.js';
import { searchContent, type ContentHit, type IndexedDoc } from './content.js';
import {
  resolveIdentifier,
  searchAll,
  countScopes,
  searchForumPage,
  searchGovernancePage,
  searchDrepsPage,
  searchRationalesPage,
  GROUP_LIMIT,
  type ExactHit,
  type GaHit,
  type TopicHit,
  type DrepHit,
  type RationaleHit,
  type ScopeCounts,
} from '../db/search.js';
import { pageToOffset } from '../forum/view.js';
import { PAGE_SIZE, type Scope } from './scopes.js';

export interface SearchCounts extends ScopeCounts {
  help: number;
  reviews: number;
}

export interface SearchResponseBody {
  query: string;
  scope: Scope;
  page: number;
  exact: ExactHit | null;
  governanceActions: GaHit[];
  discussions: TopicHit[];
  dreps: DrepHit[];
  rationales: RationaleHit[];
  reviews: ContentHit[];
  help: ContentHit[];
  total: number | null;
  counts: SearchCounts | null;
}

export interface SearchOptions {
  scope?: Scope;
  page?: number;
  counts?: boolean;
  /** The help and Governance Review index (lib/search/contentIndex.ts). */
  content?: readonly IndexedDoc[];
}

const MAX_QUERY_LENGTH = 120;
const MIN_QUERY_LENGTH = 2;

type D1Part = Pick<SearchResponseBody, 'exact' | 'governanceActions' | 'discussions' | 'dreps' | 'rationales' | 'total'> & {
  counts: ScopeCounts | null;
};

const D1_EMPTY: D1Part = { exact: null, governanceActions: [], discussions: [], dreps: [], rationales: [], total: null, counts: null };

/** No D1 results. Scoped queries report a numeric total, "all" leaves it null. */
function d1Empty(scope: Scope): D1Part {
  return { ...D1_EMPTY, total: scope === 'all' ? null : 0 };
}

function empty(query: string, scope: Scope, page: number): SearchResponseBody {
  return { query, scope, page, ...d1Empty(scope), reviews: [], help: [], counts: null };
}

/** Normalizes the raw q param: trim, collapse whitespace, cap length. */
export function normalizeQuery(raw: string | null): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
}

// opts.counts has a dual role. Its primary job is to return facet counts for
// the /search page. It also selects "page mode" vs the palette's "typeahead
// mode" for scope === 'all': the page builds each group from the scoped queries
// so its counts and results agree, while the palette keeps the merged typeahead
// groups. The scoped modes are identical in both, so they only vary the counts.
async function searchD1(db: D1Database, match: string, query: string, scope: Scope, page: number, counts: boolean): Promise<D1Part> {
  try {
    // Identifier fast-path runs for EVERY scope: a pasted DRep / governance id
    // is the most specific request a user can make, so it must resolve whatever
    // filter happens to be active. Free text resolves to null without a query.
    const ident = detectIdentifier(query);
    const exactP = ident ? resolveIdentifier(db, ident) : Promise.resolve(null);
    // Facet counts, the fast path and the page itself are independent reads,
    // so they run concurrently instead of one round trip after another.
    const countsP = counts && scope !== 'all' ? countScopes(db, match) : Promise.resolve(null);

    // Scoped modes: one entity, paginated. countScopes' per-scope totals equal
    // each scoped query's total, so the facet numbers match the result lists.
    const scoped = async <K extends 'governanceActions' | 'discussions' | 'dreps' | 'rationales'>(
      key: K,
      run: Promise<{ hits: D1Part[K]; total: number }>,
    ): Promise<D1Part> => {
      const [exact, c, r] = await Promise.all([exactP, countsP, run]);
      return { ...D1_EMPTY, exact, counts: c, [key]: r.hits, total: r.total };
    };
    switch (scope) {
      case 'governance':
        return await scoped('governanceActions', searchGovernancePage(db, match, page));
      case 'forum':
        return await scoped('discussions', searchForumPage(db, match, page));
      case 'dreps':
        return await scoped('dreps', searchDrepsPage(db, match, page));
      case 'rationales':
        return await scoped('rationales', searchRationalesPage(db, match, page));
      case 'help':
      case 'reviews': {
        // Content scopes: D1 only contributes the fast path and the facets.
        const [exact, c] = await Promise.all([exactP, countsP]);
        return { ...D1_EMPTY, exact, counts: c };
      }
    }

    if (counts) {
      // Page mode (/search): build every group from the same scoped queries
      // that back the facets, so the "All" preview and the facet counts agree.
      const [exact, gov, forum, dreps, rationales] = await Promise.all([
        exactP,
        searchGovernancePage(db, match, 1),
        searchForumPage(db, match, 1),
        searchDrepsPage(db, match, 1),
        searchRationalesPage(db, match, 1),
      ]);
      return {
        exact,
        governanceActions: gov.hits,
        discussions: forum.hits,
        dreps: dreps.hits,
        rationales: rationales.hits,
        total: null,
        counts: { forum: forum.total, governance: gov.total, dreps: dreps.total, rationales: rationales.total },
      };
    }

    // Palette mode: the merged typeahead groups (discussion hits fold into the
    // governance group). A resolved id stands alone and skips the full text.
    const exact = await exactP;
    if (exact) return { ...D1_EMPTY, exact };
    return { ...D1_EMPTY, ...(await searchAll(db, match)) };
  } catch {
    return d1Empty(scope);
  }
}

export async function handleSearch(db: D1Database | undefined, rawQuery: string | null, opts: SearchOptions = {}): Promise<SearchResponseBody> {
  const scope = opts.scope ?? 'all';
  const page = Math.max(1, opts.page ?? 1);
  const query = normalizeQuery(rawQuery);
  if (query.length < MIN_QUERY_LENGTH) return empty(query, scope, page);
  const match = buildMatch(query);
  if (!match) return empty(query, scope, page);

  const content = searchContent(opts.content ?? [], query);
  const d1 = db ? await searchD1(db, match, query, scope, page, !!opts.counts) : d1Empty(scope);
  const body: SearchResponseBody = {
    query,
    scope,
    page,
    ...d1,
    reviews: [],
    help: [],
    // Without D1 counts the facet column hides every number rather than show
    // zeros for the database scopes that could not be asked.
    counts: opts.counts && d1.counts ? { ...d1.counts, help: content.help.length, reviews: content.reviews.length } : null,
  };
  if (scope === 'help' || scope === 'reviews') {
    const offset = pageToOffset(page, PAGE_SIZE);
    body[scope] = content[scope].slice(offset, offset + PAGE_SIZE);
    body.total = content[scope].length;
  } else if (scope === 'all') {
    const limit = opts.counts ? PAGE_SIZE : GROUP_LIMIT;
    body.reviews = content.reviews.slice(0, limit);
    body.help = content.help.slice(0, limit);
  }
  return body;
}
