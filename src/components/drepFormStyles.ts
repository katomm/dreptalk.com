// Shared inline styles for the DRep tx form islands (registration, settings).
// Inline because the islands style themselves; shared so the two forms cannot
// drift apart visually.
import type { CSSProperties } from 'react';

export const inputStyle: CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: '0.375rem',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: '1rem',
};

export const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.875rem',
  marginBottom: '0.25rem',
  color: 'var(--muted)',
};
