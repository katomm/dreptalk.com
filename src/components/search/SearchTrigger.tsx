import { lazy, Suspense, useEffect, useRef, useState } from 'react';

// A failed chunk load (e.g. stale HTML after a deploy) must not crash the island.
const SearchPalette = lazy(() => import('./SearchPalette').catch(() => ({ default: () => null })));

/**
 * Header search button + global shortcuts (Cmd/Ctrl+K, and "/" outside form
 * fields). The palette body is lazy-loaded on first open so the header island
 * stays tiny; `loaded` starts false, so SSR renders only the button.
 */
export default function SearchTrigger() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hint, setHint] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Show keyboard hint only for fine-pointer devices (mouse/trackpad, not touch).
    if (window.matchMedia('(pointer: fine)').matches) {
      setHint(/Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K');
    }
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
        {hint && <span aria-hidden="true">{hint}</span>}
      </button>
      {loaded && (
        <Suspense fallback={null}>
          <SearchPalette open={open} onClose={() => setOpen(false)} returnFocusRef={btnRef} />
        </Suspense>
      )}
    </>
  );
}
