import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { SCOPES, SCOPE_LABELS, PAGE_SIZE, searchPageHref, type Scope } from '@/lib/search/scopes.js';
import type { ContentHit } from '@/lib/search/content.js';
import { otherScopesWithCounts } from '@/lib/search/emptyHint.js';
import { readableType, statusBadge, TONE_COLORS, formatAda } from '@/lib/governance/view.js';
import { truncateId } from '@/lib/forum/view.js';
import { SnippetText } from './SnippetText.js';
import type { SearchResponseBody } from '@/lib/search/handler.js';
import { avatarUrl } from '@/lib/identity/avatarUrl.js';
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
        {d.imageHash && <img src={avatarUrl(d.imageHash, 20)} alt="" width="20" height="20" loading="lazy" style={{ borderRadius: '50%', flexShrink: 0 }} />}
        <span className="search-hit__title">{d.name ?? truncateId(d.drepId)}</span>
        <span className="search-hit__status">{d.status}</span>
        {formatAda(d.votingPower) && <span className="search-hit__detail">{formatAda(d.votingPower)}</span>}
      </span>
      {d.snippet && <SnippetText raw={d.snippet} />}
    </a>
  );
}

/** A help guide, glossary term or Governance Review edition. */
function ContentRow({ h }: { h: ContentHit }) {
  return (
    <a className="search-hit" href={h.href}>
      <span className="search-hit__head">
        <span className="search-hit__title">{h.title}</span>
        {h.detail && <span className="search-hit__detail">{h.detail}</span>}
      </span>
      {h.snippet && <SnippetText raw={h.snippet} />}
      {!h.snippet && h.description && <span className="search-hit__desc">{h.description}</span>}
    </a>
  );
}

function RationaleRow({ r }: { r: RationaleHit }) {
  const kind = r.vote === 'Yes' ? 'yes' : r.vote === 'No' ? 'no' : 'abstain';
  return (
    <a className="search-hit" href={r.href}>
      <span className="search-hit__head">
        {r.imageHash && <img src={avatarUrl(r.imageHash, 20)} alt="" width="20" height="20" loading="lazy" style={{ borderRadius: '50%', flexShrink: 0 }} />}
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const didMount = useRef(false);

  const trimmed = q.trim();
  const hasQuery = trimmed.length >= MIN_QUERY;

  // Fetch results on query/scope/page change. The first render already has
  // server data, so skip that pass; only sync the URL from then on.
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    window.history.replaceState(null, '', searchPageHref(trimmed, scope, page));

    if (!hasQuery) {
      // Results only render with a query, so clearing the facet counts is enough.
      setData((d) => ({ ...d, query: trimmed, counts: null }));
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(trimmed)}&scope=${scope}&page=${page}&counts=1`,
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

  const counts = data.counts;
  const facetCount = (s: Scope): number | null => {
    if (!counts) return null;
    return s === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[s];
  };

  // Result rows per scope, in the order the "All" view stacks its groups.
  const rowsByScope: Record<Exclude<Scope, 'all'>, ReactNode[]> = {
    governance: data.governanceActions.map((ga) => <GaRow key={ga.href} ga={ga} />),
    forum: data.discussions.map((t) => <TopicRow key={t.href} t={t} />),
    dreps: data.dreps.map((d) => <DrepRow key={d.drepId} d={d} />),
    rationales: data.rationales.map((r) => <RationaleRow key={r.href} r={r} />),
    reviews: data.reviews.map((h) => <ContentRow key={h.href} h={h} />),
    help: data.help.map((h) => <ContentRow key={h.href} h={h} />),
  };
  const groups = Object.entries(rowsByScope) as Array<[Exclude<Scope, 'all'>, ReactNode[]]>;

  const changeScope = (s: Scope) => {
    setScope(s);
    setPage(1);
  };

  // Page count for the active single scope.
  const totalPages = scope === 'all' ? 1 : Math.max(1, Math.ceil((data.total ?? 0) / PAGE_SIZE));

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
        placeholder="Search governance actions, discussions, DReps, reviews, help..."
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

          {hasQuery && !error && data.exact && (
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

          {hasQuery && !error && scope === 'all' && (
            <>
              {groups.map(
                ([s, rows]) =>
                  rows.length > 0 && (
                    <Group key={s} title={SCOPE_LABELS[s]} count={facetCount(s)} onMore={() => changeScope(s)}>
                      {rows.slice(0, ALL_PREVIEW)}
                    </Group>
                  ),
              )}
              {!data.exact && groups.every(([, rows]) => rows.length === 0) && <p className="search-note">No results for "{trimmed}".</p>}
            </>
          )}

          {hasQuery &&
            !error &&
            scope !== 'all' &&
            (() => {
              const list = rowsByScope[scope];
              if (list.length > 0) return <div className="search-group">{list}</div>;
              const others = otherScopesWithCounts(counts, scope);
              if (others.length > 0) {
                return (
                  <p className="search-note">
                    No {SCOPE_LABELS[scope]} results for "{trimmed}".{' '}
                    {others.map((o, i) => (
                      <span key={o.scope}>
                        {i > 0 ? ' · ' : ''}
                        <button type="button" className="search-more" onClick={() => changeScope(o.scope)}>
                          {o.count} in {SCOPE_LABELS[o.scope]}
                        </button>
                      </span>
                    ))}
                  </p>
                );
              }
              // An exact match (rendered above) counts as a result: stay silent then.
              if (data.exact) return null;
              return <p className="search-note">No results for "{trimmed}".</p>;
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
