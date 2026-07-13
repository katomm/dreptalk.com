import { useState } from 'react';
import { TONE_COLORS } from '@/lib/governance/view';
import type { Reaction } from '@/lib/db/postReactions';

interface ReactionButtonsProps {
  postId: string;
  /** Materialized counts at render time. */
  initialUpCount: number;
  initialDownCount: number;
  /** The viewer's current reaction, or null. */
  initialReaction: Reaction | null;
  /** Whether the viewer may react (an on-chain writer, not the post author). */
  canReact: boolean;
  /** Why the viewer cannot react; shown as the button title when canReact is false. */
  disabledReason?: string;
}

/** Feather-style thumb outline; `down` renders the same shape rotated. */
function ThumbIcon({ down, filled }: { down?: boolean; filled?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={down ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z" />
      <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

/**
 * Thumbs up / thumbs down for one post. Counts are visible to everyone; only
 * eligible writers can toggle. A writer holds at most one reaction per post:
 * clicking the active side withdraws it, clicking the other side switches.
 */
export default function ReactionButtons({
  postId,
  initialUpCount,
  initialDownCount,
  initialReaction,
  canReact,
  disabledReason,
}: ReactionButtonsProps) {
  const [reaction, setReaction] = useState<Reaction | null>(initialReaction);
  const [upCount, setUpCount] = useState(initialUpCount);
  const [downCount, setDownCount] = useState(initialDownCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // Announced to screen readers on each change (the color/aria-pressed shift alone
  // does not convey the new count or a failure).
  const [status, setStatus] = useState('');

  const toggle = async (side: Reaction) => {
    if (busy || !canReact) return;
    setBusy(true);
    setError(false);
    try {
      const withdrawing = reaction === side;
      const res = await fetch(`/api/posts/${postId}/react`, {
        method: withdrawing ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(withdrawing ? {} : { body: JSON.stringify({ reaction: side }) }),
      });
      if (!res.ok) {
        setError(true);
        setStatus('Could not update reaction, please try again.');
        return;
      }
      const data = (await res.json()) as { reaction: Reaction | null; upCount: number; downCount: number };
      setReaction(data.reaction);
      setUpCount(data.upCount);
      setDownCount(data.downCount);
      setStatus(
        data.reaction === 'up'
          ? 'Thumbs up recorded.'
          : data.reaction === 'down'
            ? 'Thumbs down recorded.'
            : 'Reaction removed.',
      );
    } catch {
      setError(true);
      setStatus('Could not update reaction, please try again.');
    } finally {
      setBusy(false);
    }
  };

  const sides: { side: Reaction; count: number; activeColor: string; label: string }[] = [
    { side: 'up', count: upCount, activeColor: TONE_COLORS.positive, label: 'Thumbs up' },
    { side: 'down', count: downCount, activeColor: TONE_COLORS.negative, label: 'Thumbs down' },
  ];

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.75rem' }}>
      {sides.map(({ side, count, activeColor, label }) => {
        const active = reaction === side;
        return (
          <button
            key={side}
            type="button"
            onClick={() => toggle(side)}
            disabled={busy || !canReact}
            aria-pressed={active}
            aria-label={label}
            title={
              error
                ? 'Could not update reaction, try again'
                : canReact
                  ? label
                  : (disabledReason ?? 'Sign in with a verified on-chain role to react')
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.3rem',
              justifyContent: 'center',
              background: 'none',
              border: 'none',
              padding: '0.25rem 0.3rem',
              minHeight: '1.75rem',
              minWidth: '1.75rem',
              cursor: busy || !canReact ? 'default' : 'pointer',
              font: 'inherit',
              fontSize: '0.8125rem',
              color: error ? 'var(--danger, #c0392b)' : active ? activeColor : 'var(--muted)',
              opacity: busy ? 0.6 : 1,
            }}
          >
            <ThumbIcon down={side === 'down'} filled={active} />
            {count > 0 && <span>{count}</span>}
          </button>
        );
      })}
      <span className="sr-only" role="status" aria-live="polite">{status}</span>
    </span>
  );
}
