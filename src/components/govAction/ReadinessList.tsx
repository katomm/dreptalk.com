// The short list next to the submit button naming what is still missing.
// Presentational and dumb: the reasons are computed by readiness.ts, this only
// renders them. Nothing here decides anything, so the list and the button's
// disabled state cannot disagree.
import type { CSSProperties } from 'react';
import type { ReadinessReason } from '@/lib/governance/readiness.js';

const listStyle: CSSProperties = {
  margin: '0.35rem 0 0',
  paddingLeft: '1.1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
  fontSize: '0.875rem',
  color: 'var(--muted)',
};

export interface ReadinessListProps {
  reasons: ReadinessReason[];
}

export default function ReadinessList({ reasons }: ReadinessListProps) {
  if (reasons.length === 0) return null;
  return (
    // A status region, not an alert: nothing went wrong, the form is simply
    // not finished, and it updates while the user types.
    <div role="status" style={{ fontSize: '0.875rem' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Before you can submit</p>
      <ul style={listStyle}>
        {reasons.map(reason => (
          <li key={reason.key}>{reason.message}</li>
        ))}
      </ul>
    </div>
  );
}
