import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SCOPES, SCOPE_LABELS, PAGE_SIZE, type Scope, type ApiScope } from '@/lib/search/scopes.js';
import { searchHelp, type HelpDoc, type HelpHit } from '@/lib/search/help.js';
import { readableType, statusBadge, TONE_COLORS, formatAda } from '@/lib/governance/view.js';
import { truncateId } from '@/lib/forum/view.js';
import { SnippetText } from './SnippetText.js';
import type { SearchResponseBody } from '@/lib/search/handler.js';
import type { GaHit, TopicHit, DrepHit, RationaleHit } from '@/lib/db/search.js';

interface Props {
  initialQuery: string;
  initialScope: Scope;
  initialPage: number;
  initialData: SearchResponseBody;
}

const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;
const ALL_PREVIEW = 4; // rows per group shown under the "All" scope

function apiScopeFor(scope: Scope): ApiScope {
  return scope === 'help' ? 'all' : scope;
}

function GaRow({ ga }: { ga: GaHit }) {
  const badge = statusBadge(ga.status);
  return (
    <a className="search-hit" href={ga.href}>
      <span className="search-hit__head">
        <span className="search-hit__title">{ga.title}</span>
        <span className="search-hit__badge">{readableType(ga.type)}</span>
        <span className="search-hit__status" style={{ color: TONE_COLORS[badge.tone] }}>
          {badge.label}
        </span>
        {ga.discussionMatches > 0 && <span className="search-hit__detail">{ga.discussionMatches} in discussion</span>}
      </span>
      {ga.snippet && <SnippetText raw={ga.snippet} />}
    </a>
  );
}

function TopicRow({ t }: { t: TopicHit }) {
  return (
    <a className="search-hit" href={t.href}>
      <span className="search-hit__head">
        <span className="search-hit__title">{t.title}</span>
        <span className="search-hit__detail">
          {t.categorySlug} · {t.postCount} posts
        </span>
      </span>
      {t.snippet && <SnippetText raw={t.snippet} />}
    </a>
  );
}

function DrepRow({ d }: { d: DrepHit }) {
  return (
    <a className="search-hit" href={d.href}>
      <span className="search-hit__head">
        {d.imageHash && <img src={`/api/avatar/${d.imageHash}`} alt="" width="20" height="20" loading="lazy" style={{ borderRadius: '50%', flexShrink: 0 }} />}
        <span className="search-hit__title">{d.name ?? truncateId(d.drepId)}</span>
        <span className="search-hit__status">{d.status}</span>
        {formatAda(d.votingPower) && <span className="search-hit__detail">{formatAda(d.votingPower)}</span>}
      </span>
      {d.snippet && <SnippetText raw={d.snippet} />}
    </a>
  );
}

function HelpRow({ h }: { h: HelpHit }) {
  return (
    <a className="search-hit" href={h.href}>
      <span className="search-hit__head">
        <span className="search-hit__title">{h.title}</span>
        <span className="search-hit__badge">Help</span>
      </span>
      {h.snippet && <SnippetText raw={h.snippet} />}
    </a>
  );
}

function RationaleRow({ r }: { r: RationaleHit }) {
  const kind = r.vote === 'Yes' ? 'yes' : r.vote === 'No' ? 'no' : 'abstain';
  return (
    <a className="search-hit" href={r.href}>
      <span className="search-hit__head">
        {r.imageHash && <img src={`/api/avatar/${r.imageHash}`} alt="" width="20" height="20" loading="lazy" style={{ borderRadius: '50%', flexShrink: 0 }} />}
        <span className="search-hit__title">{r.name ?? truncateId(r.voterId)}</span>
        <span className={`search-hit__vote search-hit__vote--${kind}`}>{r.vote}</span>
        <span className="search-hit__detail">{r.actionTitle}</span>
      </span>
      {r.snippet && <SnippetText raw={r.snippet} />}
    </a>
  );
}

function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(
    (p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2,
  );
  const items: (number | 'gap')[] = [];
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) items.push('gap');
    items.push(p);
    prev = p;
  }
  return (
    <nav className="search-pagination" aria-label="Search result pages">
      <button type="button" className="search-page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Prev
      </button>
      {items.map((it, i) =>
        it === 'gap' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static ellipsis marker, position is stable
          <span key={`gap-${i}`} className="search-page-gap">
            …
          </span>
        ) : (
          <button
            type="button"
            key={it}
            className="search-page"
            aria-current={it === page ? 'page' : undefined}
            data-active={it === page ? '' : undefined}
            onClick={() => onPage(it)}
          >
            {it}
          </button>
        ),
      )}
      <button type="button" className="search-page" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

export default function SearchResults({ initialQuery, initialScope, initialPage, initialData }: Props) {
  const [q, setQ] = useState(initialQuery);
  const [scope, setScope] = useState<Scope>(initialScope);
  const [page, setPage] = useState(initialPage);
  const [data, setData] = useState<SearchResponseBody>(initialData);
  const [helpDocs, setHelpDocs] = useState<HelpDoc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const didMount = useRef(false);

  const trimmed = q.trim();
  const hasQuery = trimmed.length >= MIN_QUERY;

  // Load the static help index once; failure just hides the Help facet.
  useEffect(() => {
    let alive = true;
    fetch('/help-search-index.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((docs) => {
        if (alive && Array.isArray(docs)) setHelpDocs(docs as HelpDoc[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Fetch D1 data on query/scope/page change. The first render already has
  // server data, so skip that pass; only sync the URL from then on.
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    const url = `/search/?q=${encodeURIComponent(trimmed)}${scope === 'all' ? '' : `&scope=${scope}`}${page > 1 ? `&page=${page}` : ''}`;
    window.history.replaceState(null, '', url);

    if (!hasQuery) {
      setData((d) => ({ ...d, query: trimmed, governanceActions: [], discussions: [], dreps: [], exact: null, total: 0, counts: null }));
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(trimmed)}&scope=${apiScopeFor(scope)}&page=${page}&counts=1`,
          { signal: ctrl.signal },
        );
        if (!res.ok) throw new Error('bad status');
        const json = (await res.json()) as SearchResponseBody;
        if (ctrl.signal.aborted) return;
        setData(json);
        setError(false);
      } catch {
        if (!ctrl.signal.aborted) setError(true);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [trimmed, scope, page, hasQuery]);

  const helpHits = useMemo(() => (helpDocs && hasQuery ? searchHelp(helpDocs, trimmed) : []), [helpDocs, hasQuery, trimmed]);

  const counts = data.counts;
  const facetCount = (s: Scope): number | null => {
    if (s === 'help') return helpDocs ? helpHits.length : null;
    if (!counts) return null;
    if (s === 'forum') return counts.forum;
    if (s === 'governance') return counts.governance;
    if (s === 'dreps') return counts.dreps;
    if (s === 'rationales') return counts.rationales;
    // all
    return counts.forum + counts.governance + counts.dreps + counts.rationales + (helpDocs ? helpHits.length : 0);
  };

  const changeScope = (s: Scope) => {
    setScope(s);
    setPage(1);
  };

  // Total + page count for the active single scope.
  const total = scope === 'help' ? helpHits.length : (data.total ?? 0);
  const totalPages = scope === 'all' ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE));
  const helpPageSlice = helpHits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="search-layout">
      <input
        type="search"
        className="search-input"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
        placeholder="Search governance actions, discussions, DReps, help..."
        aria-label="Search"
        // biome-ignore lint/a11y/noAutofocus: dedicated search page, the input is the primary control
        autoFocus
      />

      <div className="search-body">
        <aside className="search-facets" aria-label="Filter by type">
          {SCOPES.map((s) => {
            const c = facetCount(s);
            return (
              <button
                type="button"
                key={s}
                className="search-facet"
                aria-pressed={s === scope}
                data-active={s === scope ? '' : undefined}
                onClick={() => changeScope(s)}
              >
                <span>{SCOPE_LABELS[s]}</span>
                {c != null && <span className="search-facet__count">{c}</span>}
              </button>
            );
          })}
        </aside>

        <div className="search-hits" aria-live="polite" aria-busy={loading}>
          {!hasQuery && <p className="search-note">Type at least two characters to search.</p>}
          {hasQuery && error && <p className="search-note">Search is unavailable right now.</p>}

          {hasQuery && !error && scope === 'all' && (
            <>
              {data.exact && (
                <section className="search-group">
                  <h2 className="search-group__title">Exact match</h2>
                  <a className="search-hit" href={data.exact.href}>
                    <span className="search-hit__head">
                      <span className="search-hit__title">{data.exact.label}</span>
                      <span className="search-hit__badge">{data.exact.kind === 'governance-action' ? 'Governance Action' : 'DRep'}</span>
                    </span>
                  </a>
                </section>
              )}
              {data.governanceActions.length > 0 && (
                <Group title="Governance" count={facetCount('governance')} onMore={() => changeScope('governance')}>
                  {data.governanceActions.slice(0, ALL_PREVIEW).map((ga) => (
                    <GaRow key={ga.href} ga={ga} />
                  ))}
                </Group>
              )}
              {data.discussions.length > 0 && (
                <Group title="Discussions" count={facetCount('forum')} onMore={() => changeScope('forum')}>
                  {data.discussions.slice(0, ALL_PREVIEW).map((t) => (
                    <TopicRow key={t.href} t={t} />
                  ))}
                </Group>
              )}
              {data.dreps.length > 0 && (
                <Group title="DReps" count={facetCount('dreps')} onMore={() => changeScope('dreps')}>
                  {data.dreps.slice(0, ALL_PREVIEW).map((d) => (
                    <DrepRow key={d.drepId} d={d} />
                  ))}
                </Group>
              )}
              {data.rationales.length > 0 && (
                <Group title="Rationales" count={facetCount('rationales')} onMore={() => changeScope('rationales')}>
                  {data.rationales.slice(0, ALL_PREVIEW).map((r) => (
                    <RationaleRow key={r.href} r={r} />
                  ))}
                </Group>
              )}
              {helpHits.length > 0 && (
                <Group title="Help" count={facetCount('help')} onMore={() => changeScope('help')}>
                  {helpHits.slice(0, ALL_PREVIEW).map((h) => (
                    <HelpRow key={h.href} h={h} />
                  ))}
                </Group>
              )}
              {!data.exact &&
                data.governanceActions.length === 0 &&
                data.discussions.length === 0 &&
                data.dreps.length === 0 &&
                data.rationales.length === 0 &&
                helpHits.length === 0 && <p className="search-note">No results for "{trimmed}".</p>}
            </>
          )}

          {hasQuery &&
            !error &&
            scope !== 'all' &&
            (() => {
              // One data-driven scoped list. Each scope maps to its result rows.
              const rows: Record<Exclude<Scope, 'all'>, ReactNode[]> = {
                governance: data.governanceActions.map((ga) => <GaRow key={ga.href} ga={ga} />),
                forum: data.discussions.map((t) => <TopicRow key={t.href} t={t} />),
                dreps: data.dreps.map((d) => <DrepRow key={d.drepId} d={d} />),
                rationales: data.rationales.map((r) => <RationaleRow key={r.href} r={r} />),
                help: helpPageSlice.map((h) => <HelpRow key={h.href} h={h} />),
              };
              const list = rows[scope];
              return (
                <ScopeList empty={list.length === 0} q={trimmed}>
                  {list}
                </ScopeList>
              );
            })()}

          {hasQuery && !error && scope !== 'all' && <Pagination page={page} totalPages={totalPages} onPage={setPage} />}
        </div>
      </div>
    </div>
  );
}

function Group({ title, count, onMore, children }: { title: string; count: number | null; onMore: () => void; children: ReactNode }) {
  const shown = Array.isArray(children) ? children.length : 1;
  const more = count != null && count > shown;
  return (
    <section className="search-group">
      <h2 className="search-group__title">
        {title}
        {count != null && <span className="search-group__count">{count}</span>}
      </h2>
      {children}
      {more && (
        <button type="button" className="search-more" onClick={onMore}>
          More in {title} →
        </button>
      )}
    </section>
  );
}

function ScopeList({ empty, q, children }: { empty: boolean; q: string; children: ReactNode }) {
  if (empty) return <p className="search-note">No results for "{q}".</p>;
  return <div className="search-group">{children}</div>;
}
