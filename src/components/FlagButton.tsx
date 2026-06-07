import { useState } from 'react';

interface FlagButtonProps {
  postId: string;
  /** Whether the current viewer has already flagged this post. */
  initialFlagged: boolean;
  /** Distinct flag count at render time. */
  initialCount: number;
}

// Mirrors the server policy in src/lib/db/postFlags.ts.
const HIDE_THRESHOLD = 3;

/**
 * Small toggle for community flagging, shown only to eligible writers. Flags or
 * unflags the post and reflects the new count. When a flag pushes the post over
 * the hide threshold (or an unflag brings it back), the page is reloaded so the
 * server re-renders the post as a placeholder (or restores it).
 */
export default function FlagButton({ postId, initialFlagged, initialCount }: FlagButtonProps) {
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
      const wasHidden = count >= HIDE_THRESHOLD;
      if (data.hidden !== wasHidden) {
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
