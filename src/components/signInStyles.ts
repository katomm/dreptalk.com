// Shared inline styles for the sign-in method islands (wallet, cardano-signer,
// pair with desktop). Lifted out of SignIn.tsx rather than exported from it so
// PairWithDesktop.tsx can reuse them without a circular import between the two
// component modules.
import type { CSSProperties } from 'react';

// Where a successful login lands, shared by the wallet, cardano-signer and
// pairing flows so the entry points can never drift onto different start pages.
export const POST_LOGIN_DEST = '/home/';

export const cardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 14px)',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow)',
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

export const stepHeadingStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.9375rem',
  fontWeight: 700,
  color: 'var(--fg)',
  marginBottom: '0.6rem',
};

export const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 600,
  color: 'var(--muted)',
  marginBottom: '0.4rem',
};

export const inputStyle: CSSProperties = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: '0.9375rem',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

export const codeBlockStyle: CSSProperties = {
  display: 'block',
  margin: 0,
  padding: '0.75rem',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm, 9px)',
  fontSize: '0.75rem',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: 'var(--fg)',
  lineHeight: 1.55,
};

export const linkBtnStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
  padding: 0,
  font: 'inherit',
  textDecoration: 'underline',
  fontSize: '0.8125rem',
};
