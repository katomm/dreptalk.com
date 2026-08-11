// Desktop select-to-quote: when the user finishes a mouse text selection inside a
// single post body, show a floating "Quote reply" button. Clicking it dispatches
// the passage (clamped to that one post) to the Composer via a window event. This
// island only detects and dispatches, the Composer decides whether to append and
// shows the confirmation. Mounted once per thread, inside the writer-only gate.
import { useEffect, useRef, useState } from 'react';
import { dispatchQuote, type QuoteEventDetail } from '@/lib/forum/quoteEvent.js';

interface FloatingButton {
  top: number;
  left: number;
  detail: QuoteEventDetail;
}

// anchorNode is usually a Text node, which has no closest(), so climb to an
// element first, then find the enclosing post article.
function closestPostArticle(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest<HTMLElement>('article[data-post-id]') ?? null;
}

// Intersects the selection with the post body so a drag that spills into the next
// post quotes only the anchor post's portion. Returns the clamped range, or null
// when there is no usable overlap. Works for backward selections too, since it
// compares boundary points rather than trusting anchor/focus order.
function clampRangeToPost(range: Range, article: HTMLElement): Range | null {
  const prose = article.querySelector<HTMLElement>('.prose');
  if (!prose) return null;
  const postRange = document.createRange();
  postRange.selectNodeContents(prose);
  const clamped = range.cloneRange();
  if (clamped.compareBoundaryPoints(Range.START_TO_START, postRange) < 0) {
    clamped.setStart(postRange.startContainer, postRange.startOffset);
  }
  if (clamped.compareBoundaryPoints(Range.END_TO_END, postRange) > 0) {
    clamped.setEnd(postRange.endContainer, postRange.endOffset);
  }
  return clamped.collapsed ? null : clamped;
}

// The composer refuses quotes while editing or submitting, so do not offer one.
function composerBusy(): boolean {
  const state = document.querySelector('form[data-composer-state]')?.getAttribute('data-composer-state');
  return state === 'edit' || state === 'submitting';
}

export default function QuoteSelection() {
  const [button, setButton] = useState<FloatingButton | null>(null);
  // Payload captured at show time, so the click never re-reads a selection that
  // the click itself may have collapsed.
  const buttonRef = useRef<FloatingButton | null>(null);
  buttonRef.current = button;

  useEffect(() => {
    const clear = () => setButton(null);

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (e.target instanceof Element && e.target.closest('[data-quote-button]')) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return clear();
      const article = closestPostArticle(sel.anchorNode);
      if (!article) return clear();
      const range = clampRangeToPost(sel.getRangeAt(0), article);
      if (!range) return clear();
      const text = range.toString().trim();
      if (text.length < 2) return clear();
      if (composerBusy()) return clear();

      const postId = article.getAttribute('data-post-id') ?? '';
      if (!postId) return clear();
      const author = article.getAttribute('data-post-author') ?? '';
      const u = new URL(window.location.href);
      u.hash = `post-${postId}`;
      const href = u.pathname + u.search + u.hash;

      const rect = range.getBoundingClientRect();
      setButton({
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
        detail: { postId, author, text, href },
      });
    };

    // A pointerdown outside the button dismisses it (and precedes a fresh drag).
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-quote-button]')) return;
      clear();
    };
    const onScroll = () => clear();
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') clear(); };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) clear();
    };

    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, []);

  if (!button) return null;

  return (
    <button
      type="button"
      data-quote-button
      // Keep the selection alive: a plain click would collapse it before onClick.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const b = buttonRef.current;
        if (b) dispatchQuote(b.detail);
        window.getSelection()?.removeAllRanges();
        setButton(null);
      }}
      style={{
        position: 'fixed',
        top: button.top,
        left: button.left,
        transform: 'translate(-50%, -100%)',
        zIndex: 60,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.375rem',
        padding: '0.375rem 0.625rem',
        fontSize: '0.8125rem',
        background: 'var(--fg)',
        color: 'var(--bg)',
        border: 'none',
        borderRadius: '0.375rem',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
        <path d="M7 7h4v6H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm8 0h4v6h-4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
      </svg>
      Quote reply
    </button>
  );
}
