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

/** Secondary help and note text, smaller than a label and in the muted colour. */
export const mutedStyle: CSSProperties = {
  color: 'var(--muted)',
  fontSize: '0.8125rem',
};

/**
 * A button that reads as an inline link: the accent colour, underlined, and
 * sitting in the running text at the surrounding font size. Used for the small
 * in-sentence actions ("Check again", "Use a different wallet", "Try again",
 * "Retry") that are real buttons rather than navigation.
 */
export const linkButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
  padding: 0,
  font: 'inherit',
  textDecoration: 'underline',
};
