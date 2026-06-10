import type { KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { matchStaticEntries } from '@/lib/search/staticEntries.js';
import { parseSnippet, cleanMarkdownSnippet } from '@/lib/search/snippet.js';
import { readableType, statusBadge, TONE_COLORS, formatAda } from '@/lib/governance/view.js';
import { truncateId } from '@/lib/forum/view.js';
import type { SearchResponseBody } from '@/lib/search/handler.js';

interface PaletteProps {
  open: boolean;
  onClose: () => void;
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
  avatar?: string;
}

const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;

function buildRows(q: string, data: SearchResponseBody | null): Row[] {
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
      avatar: `/api/avatar/${encodeURIComponent(d.drepId)}`,
    });
  }
  for (const e of matchStaticEntries(q)) {
    rows.push({ key: `static-${e.href}`, href: e.href, group: e.group, label: e.label });
  }
  return rows;
}

function Snippet({ raw }: { raw: string }) {
  const segments = parseSnippet(cleanMarkdownSnippet(raw));
  if (!segments.some((s) => s.match)) return null;
  return (
    <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {segments.map((s, i) =>
        s.match ? (
          <mark key={i} style={{ background: 'transparent', color: 'var(--accent)', fontWeight: 600 }}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

export default function SearchPalette({ open, onClose }: PaletteProps) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<SearchResponseBody | null>(null);
  const [error, setError] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + scroll lock while open.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Debounced fetch.
  useEffect(() => {
    if (!open) return;
    const trimmed = q.trim();
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
          return;
        }
        setData((await res.json()) as SearchResponseBody);
        setError(false);
        setActive(0);
      } catch {
        if (!ctrl.signal.aborted) setError(true);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

  const rows = useMemo(() => buildRows(q, q.trim().length >= MIN_QUERY ? data : null), [q, data]);
  const clampedActive = Math.min(active, Math.max(rows.length - 1, 0));

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
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
      if (row) window.location.assign(row.href);
    } else if (e.key === 'Tab') {
      // Single-field dialog: keep focus on the input; options move by arrows.
      e.preventDefault();
    }
  };

  let lastGroup = '';

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, overflowY: 'auto', padding: '10vh 1rem 1rem' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={onKeyDown}
        style={{ maxWidth: '40rem', margin: '0 auto', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}
      >
        <input
          ref={inputRef}
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
        <div id="search-palette-listbox" role="listbox" aria-label="Search results" style={{ maxHeight: '60vh', overflowY: 'auto', padding: '0.25rem 0' }}>
          {error && (
            <p style={{ margin: 0, padding: '0.6rem 1rem', fontSize: '0.8125rem', color: 'var(--muted)' }}>
              Search is unavailable right now.
            </p>
          )}
          {!error && rows.length === 0 && q.trim().length >= MIN_QUERY && (
            <p style={{ margin: 0, padding: '0.6rem 1rem', fontSize: '0.8125rem', color: 'var(--muted)' }}>
              No results for "{q.trim()}".
            </p>
          )}
          {rows.map((row, i) => {
            const header = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <div key={row.key}>
                {header && (
                  <div aria-hidden="true" style={{ padding: '0.5rem 1rem 0.2rem', fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
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
                  {row.snippet && <Snippet raw={row.snippet} />}
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
