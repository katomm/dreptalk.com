import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { HelpEntry } from '@/lib/search/staticEntries.js';

// A failed chunk load (e.g. stale HTML after a deploy) must not crash the island.
const SearchPalette = lazy(() => import('./SearchPalette').catch(() => ({ default: () => null })));

interface TriggerProps {
  helpEntries: HelpEntry[];
}

/**
 * Header search button + global shortcuts (Cmd/Ctrl+K, and "/" outside form
 * fields). The palette body is lazy-loaded on first open so the header island
 * stays tiny; `loaded` starts false, so SSR renders only the button.
 */
export default function SearchTrigger({ helpEntries }: TriggerProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setLoaded(true);
        setOpen((o) => !o);
        return;
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        e.preventDefault();
        setLoaded(true);
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pre-mount the lazy palette (hidden; it renders null while closed) once this
  // island has hydrated. That resolves the chunk during idle, so the first open
  // mounts synchronously inside the tap gesture and the input's autoFocus can
  // raise the mobile keyboard. Without this, the first open waits on the async
  // import and the focus lands outside the gesture window.
  useEffect(() => {
    setLoaded(true);
  }, []);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="Search"
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          padding: '0.4rem 0.6rem',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          background: 'transparent',
          color: 'var(--muted)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: '0.8125rem',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
        <span aria-hidden="true">Search</span>
      </button>
      {loaded && (
        <Suspense fallback={null}>
          <SearchPalette open={open} onClose={() => setOpen(false)} returnFocusRef={btnRef} helpEntries={helpEntries} />
        </Suspense>
      )}
    </>
  );
}
