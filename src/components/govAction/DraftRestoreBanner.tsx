// Shown at the top of /ga/new when a stored draft was restored, so the
// restore is not silent and there is a way to discard it besides emptying
// every field by hand. Presentational: the island decides whether a draft was
// restored and owns the discard handler, this only renders the message and
// the button.
import type { CSSProperties } from 'react';
import { formatRelativeTime } from '@/lib/forum/view.js';

export interface DraftRestoreBannerProps {
  /**
   * When the restored draft was saved, in ms. null means the draft predates
   * the savedAt field, which shows a plain "your saved draft" instead of a
   * relative time.
   */
  savedAt: number | null;
  /** The current time, in ms, for the relative-time calculation. */
  now: number;
  onDiscard: () => void;
  /**
   * True while a submit is running. Discarding then would empty the form
   * under a handler that is still reading it, so the button is taken out of
   * reach for as long as that lasts.
   */
  disabled?: boolean;
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.75rem',
  flexWrap: 'wrap',
};

const discardButtonStyle = (disabled: boolean): CSSProperties => ({
  background: 'none',
  border: 'none',
  color: disabled ? 'var(--muted)' : 'var(--accent)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  padding: 0,
  font: 'inherit',
  fontSize: '0.875rem',
  textDecoration: 'underline',
  flexShrink: 0,
});

export default function DraftRestoreBanner({ savedAt, now, onDiscard, disabled = false }: DraftRestoreBannerProps) {
  const message =
    savedAt === null ? 'Restored your saved draft' : `Restored your draft from ${formatRelativeTime(savedAt, now)}`;
  return (
    <div className="callout callout--info" role="status">
      <div className="callout__body" style={bodyStyle}>
        <span>{message}</span>
        <button type="button" onClick={onDiscard} disabled={disabled} style={discardButtonStyle(disabled)}>
          Discard
        </button>
      </div>
    </div>
  );
}
