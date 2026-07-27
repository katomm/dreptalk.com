import type { KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type React from 'react';
import { matchStaticEntries, matchEntries, type HelpEntry } from '@/lib/search/staticEntries.js';
import { readableType, statusBadge, TONE_COLORS, formatAda } from '@/lib/governance/view.js';
import { truncateId } from '@/lib/forum/view.js';
import type { SearchResponseBody } from '@/lib/search/handler.js';
import { SCOPES, SCOPE_LABELS, type Scope } from '@/lib/search/scopes.js';
import { filterRowsByScope } from '@/lib/search/paletteFilter.js';
import { SnippetText } from './SnippetText.js';

interface PaletteProps {
  open: boolean;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  helpEntries: HelpEntry[];
  /** Scope pill preselected each time the palette opens (defaults to "all").
      Help and glossary pages pass "help" so a search starts within them. */
  initialScope?: Scope;
}

interface Row {
  key: string;
  href: string;
  group: string;
  label: string;
  badge?: string;
  status?: string;
  statusColor?: string;
  detail?: string;
  snippet?: string | null;
  description?: string;
  avatar?: string;
}

const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;

function buildRows(q: string, data: SearchResponseBody | null, helpEntries: HelpEntry[]): Row[] {
  const rows: Row[] = [];
  if (data?.exact) {
    rows.push({
      key: 'exact',
      href: data.exact.href,
      group: 'Exact match',
      label: data.exact.label,
      badge: data.exact.kind === 'governance-action' ? 'Governance Action' : 'DRep',
    });
  }
  for (const ga of data?.governanceActions ?? []) {
    const badge = statusBadge(ga.status);
    rows.push({
      key: `ga-${ga.href}`,
      href: ga.href,
      group: 'Governance Actions',
      label: ga.title,
      badge: readableType(ga.type),
      status: badge.label,
      statusColor: TONE_COLORS[badge.tone],
      detail: ga.discussionMatches > 0 ? `${ga.discussionMatches} in discussion` : undefined,
      snippet: ga.snippet,
    });
  }
  for (const t of data?.discussions ?? []) {
    rows.push({
      key: `topic-${t.href}`,
      href: t.href,
      group: 'Discussions',
      label: t.title,
      detail: `${t.categorySlug} · ${t.postCount} posts`,
      snippet: t.snippet,
    });
  }
  for (const d of data?.dreps ?? []) {
    rows.push({
      key: `drep-${d.drepId}`,
      href: d.href,
      group: 'DReps',
      label: d.name ?? truncateId(d.drepId),
      detail: formatAda(d.votingPower) ?? undefined,
      status: d.status,
      snippet: d.snippet,
      ...(d.imageHash ? { avatar: `/api/avatar/${d.imageHash}` } : {}),
    });
  }
  for (const r of data?.rationales ?? []) {
    rows.push({
      key: `rat-${r.href}`,
      href: r.href,
      group: 'Rationales',
      label: r.drepName ?? truncateId(r.drepId),
      badge: r.vote,
      detail: r.actionTitle,
      snippet: r.snippet,
      ...(r.imageHash ? { avatar: `/api/avatar/${r.imageHash}` } : {}),
    });
  }
  for (const e of matchStaticEntries(q)) {
    rows.push({ key: `static-${e.href}`, href: e.href, group: e.group, label: e.label });
  }
  for (const e of matchEntries(helpEntries, q)) {
    rows.push({ key: `help-${e.href}`, href: e.href, group: 'Help', label: e.label, description: e.description });
  }
  return rows;
}

export default function SearchPalette({ open, onClose, returnFocusRef, helpEntries, initialScope = 'all' }: PaletteProps) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<SearchResponseBody | null>(null);
  const [error, setError] = useState(false);
  const [active, setActive] = useState(0);
  const [scope, setScope] = useState<Scope>(initialScope);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevOpenRef = useRef(false);

  const trimmed = q.trim();
  const hasQuery = trimmed.length >= MIN_QUERY;

  // Build all rows, then narrow to the active scope pill (pure client filter).
  const allRows = useMemo(() => buildRows(q, hasQuery ? data : null, helpEntries), [q, hasQuery, data, helpEntries]);
  const rows = useMemo(() => filterRowsByScope(allRows, scope), [allRows, scope]);
  const clampedActive = Math.min(active, Math.max(rows.length - 1, 0));

  // The dedicated results page carries the active query and scope.
  const seeAllHref = `/search/?q=${encodeURIComponent(trimmed)}${scope === 'all' ? '' : `&scope=${scope}`}`;

  // Focus + scroll lock while open; reset the scope pill each time it opens.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    setScope(initialScope);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open, initialScope]);

  // Scroll the active option into view when the selection changes.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`search-opt-${clampedActive}`)?.scrollIntoView({ block: 'nearest' });
  }, [clampedActive, open]);

  // Return focus to the trigger button when the palette closes.
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      returnFocusRef?.current?.focus();
    }
    prevOpenRef.current = open;
  }, [open, returnFocusRef]);

  // Debounced fetch.
  useEffect(() => {
    if (!open) return;
    if (trimmed.length < MIN_QUERY) {
      setData(null);
      setError(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal: ctrl.signal });
        if (!res.ok) {
          setError(true);
          setData(null);
          return;
        }
        const json = (await res.json()) as SearchResponseBody;
        if (ctrl.signal.aborted) return;
        setData(json);
        setError(false);
        setActive(0);
      } catch {
        if (!ctrl.signal.aborted) {
          setError(true);
          setData(null);
        }
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [trimmed, open]);

  if (!open) return null;

  // The island is mounted inside .site-header, which has backdrop-filter.
  // backdrop-filter creates a new containing block for fixed-position descendants,
  // so the overlay would be clipped to the header band instead of covering the
  // viewport. Rendering through a portal to document.body escapes that containing
  // block. The component is client-only and open starts false, so document.body
  // is always available here.

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[clampedActive];
      // With a query but no active row, Enter jumps to the full results page.
      if (row) window.location.assign(row.href);
      else if (hasQuery) window.location.assign(seeAllHref);
    } else if (e.key === 'Tab') {
      // Single-field dialog: keep focus on the input; options move by arrows.
      e.preventDefault();
    }
  };

  let lastGroup = '';

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: click-away backdrop, not a control; Escape handles keyboard dismissal and the inner role="dialog" owns the semantics
    <div
      role="presentation"
      onMouseDown={(e) => {
        // Ignore clicks on the scrollbar (within the last 16 px on the right).
        if (e.target === e.currentTarget && e.clientX < document.documentElement.clientWidth - 16) onClose();
      }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, overflowY: 'auto', padding: '10vh 1rem 1rem' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          // Keep focus on the input when clicking palette chrome (headers, padding, empty state).
          // Allow default for link clicks, buttons (scope pills), and the input itself so they work normally.
          if (!(e.target as HTMLElement).closest('a, input, button')) e.preventDefault();
        }}
        style={{ maxWidth: '40rem', margin: '0 auto', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}
      >
        <input
          ref={inputRef}
          // Focus during the commit, within the tap's user-gesture window, so
          // mobile browsers raise the software keyboard. A focus() in an effect
          // runs after paint, outside the gesture, and iOS then suppresses the
          // keyboard non-deterministically. The effect focus below stays as a
          // desktop fallback (a no-op when autoFocus already focused).
          // biome-ignore lint/a11y/noAutofocus: the user explicitly opened the search dialog; focusing its single input is expected
          autoFocus
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="search-palette-listbox"
          aria-activedescendant={rows.length > 0 ? `search-opt-${clampedActive}` : undefined}
          aria-autocomplete="list"
          type="text"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          placeholder="Search governance actions, discussions, DReps..."
          style={{ width: '100%', padding: '0.9rem 1rem', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'inherit', font: 'inherit', outline: 'none', boxSizing: 'border-box' }}
        />
        <div
          role="toolbar"
          aria-label="Filter by type"
          style={{ display: 'flex', gap: '0.3rem', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}
        >
          {SCOPES.map((s) => {
            const activeScope = s === scope;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={activeScope}
                onClick={() => {
                  setScope(s);
                  setActive(0);
                }}
                style={{
                  padding: '0.2rem 0.6rem',
                  fontWeight: activeScope ? 600 : 400,
                  color: activeScope ? 'var(--accent)' : 'var(--muted)',
                  background: activeScope ? 'var(--surface)' : 'transparent',
                  border: `1px solid ${activeScope ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  // fontFamily (not the `font` shorthand) so toggling fontWeight on
                  // active change doesn't trip React's shorthand-conflict warning.
                  fontFamily: 'inherit',
                  fontSize: '0.75rem',
                }}
              >
                {SCOPE_LABELS[s]}
              </button>
            );
          })}
        </div>
        {error && (
          <p style={{ margin: 0, padding: '0.6rem 1rem', fontSize: '0.8125rem', color: 'var(--muted)' }}>
            Search is unavailable right now.
          </p>
        )}
        {!error && rows.length === 0 && hasQuery && (
          <p style={{ margin: 0, padding: '0.6rem 1rem', fontSize: '0.8125rem', color: 'var(--muted)' }}>
            No results for "{trimmed}".
          </p>
        )}
        <div id="search-palette-listbox" role="listbox" aria-label="Search results" style={{ maxHeight: '60vh', overflowY: 'auto', padding: '0.25rem 0' }}>
          {rows.map((row, i) => {
            const header = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <div key={row.key} role="presentation">
                {header && (
                  <div role="presentation" style={{ padding: '0.5rem 1rem 0.2rem', fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
                    {header}
                  </div>
                )}
                <a
                  id={`search-opt-${i}`}
                  role="option"
                  aria-selected={i === clampedActive}
                  href={row.href}
                  onMouseEnter={() => setActive(i)}
                  onClick={onClose}
                  style={{
                    display: 'block',
                    padding: '0.5rem 1rem',
                    textDecoration: 'none',
                    color: 'inherit',
                    background: i === clampedActive ? 'var(--surface)' : 'transparent',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                    {row.avatar && (
                      <img src={row.avatar} alt="" width="20" height="20" loading="lazy" style={{ borderRadius: '50%', flexShrink: 0 }} />
                    )}
                    <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
                    {row.badge && <span style={{ flexShrink: 0, fontSize: '0.6875rem', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0 0.3rem' }}>{row.badge}</span>}
                    {row.status && <span style={{ flexShrink: 0, fontSize: '0.6875rem', color: row.statusColor ?? 'var(--muted)' }}>{row.status}</span>}
                    {row.detail && <span style={{ flexShrink: 0, marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--muted)' }}>{row.detail}</span>}
                  </span>
                  {row.snippet && <SnippetText raw={row.snippet} />}
                  {!row.snippet && row.description && (
                    <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.description}
                    </span>
                  )}
                </a>
              </div>
            );
          })}
        </div>
        {hasQuery && (
          <a
            href={seeAllHref}
            onClick={onClose}
            style={{
              display: 'block',
              padding: '0.6rem 1rem',
              borderTop: '1px solid var(--border)',
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
          >
            See all results for "{trimmed}" →
          </a>
        )}
      </div>
    </div>,
    document.body,
  );
}
