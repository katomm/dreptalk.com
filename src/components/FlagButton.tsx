import { useState } from 'react';

interface FlagButtonProps {
  postId: string;
  /** Whether the current viewer has already flagged this post. */
  initialFlagged: boolean;
  /** Distinct flag count at render time. */
  initialCount: number;
  /** Whether the post is currently hidden (the threshold lives on the server). */
  initialHidden: boolean;
}

/**
 * Small toggle for community flagging, shown only to eligible writers. Flags or
 * unflags the post and reflects the new count. When the server reports that the
 * post's hidden state changed, the page is reloaded so it re-renders as a
 * placeholder (or restores the content).
 */
export default function FlagButton({ postId, initialFlagged, initialCount, initialHidden }: FlagButtonProps) {
  const [flagged, setFlagged] = useState(initialFlagged);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/posts/${postId}/flag`, {
        method: flagged ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = (await res.json()) as { flagged: boolean; flagCount: number; hidden: boolean };
      // A change in visibility means the server renders the post differently;
      // reload so the placeholder (or restored content) shows correctly.
      if (data.hidden !== initialHidden) {
        window.location.reload();
        return;
      }
      setFlagged(data.flagged);
      setCount(data.flagCount);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const label = flagged ? 'Flagged' : 'Flag';

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={flagged}
      title={error ? 'Could not update flag, try again' : 'Flag this post for community review'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: busy ? 'default' : 'pointer',
        font: 'inherit',
        fontSize: '0.8125rem',
        color: error ? 'var(--danger, #c0392b)' : flagged ? 'var(--accent)' : 'var(--muted)',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <span aria-hidden="true">⚑</span>
      <span>{label}{count > 0 ? ` (${count})` : ''}</span>
    </button>
  );
}
