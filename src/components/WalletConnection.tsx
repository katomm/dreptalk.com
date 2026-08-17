// Compact wallet summary used across the signing flows. The wallet is only a
// signing detail: the common case is a single wallet, so it shows as one row
// instead of a full radio list. "Change wallet" appears only when more than one
// wallet is present and reveals the shared WalletPicker on demand. The label and
// note are caller-provided so each flow can word it honestly (we only enable the
// wallet at sign time, so pre-connect flows say "Signing wallet", not "connected").
import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { CardanoWalletInfo } from '@/lib/wallet/useCardanoWallets.js';
import WalletPicker from '@/components/WalletPicker.js';

interface WalletConnectionProps {
  wallets: CardanoWalletInfo[];
  selected: string;
  onSelect: (key: string) => void;
  disabled?: boolean;
  /** Small heading above the wallet name. Defaults to "Connected wallet". */
  label?: string;
  /** Optional helper line under the row; omitted when not provided. */
  note?: string;
  /**
   * Set by flows that need the CIP-95 extension (registering, voting, editing
   * or retiring a DRep). The selection already prefers a CIP-95 wallet, so this
   * only shows when none of the installed wallets can do it or the user picked
   * an incapable one on purpose. Saying so here beats letting them click
   * through to the failure.
   */
  requiresCip95?: boolean;
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius, 14px)',
  padding: '1rem 1.25rem',
};

const badgeStyle: CSSProperties = {
  fontSize: '0.6875rem',
  fontWeight: 600,
  color: 'var(--muted)',
  border: '1px solid var(--border)',
  borderRadius: '999px',
  padding: '0.05rem 0.4rem',
  flexShrink: 0,
};

const monoStyle: CSSProperties = {
  width: 32,
  height: 32,
  flexShrink: 0,
  borderRadius: '0.5rem',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.9375rem',
  fontWeight: 600,
  color: 'var(--muted)',
};

/** First letter of the wallet name, used when the extension exposes no icon. */
function monogram(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export default function WalletConnection({ wallets, selected, onSelect, disabled, label = 'Connected wallet', note, requiresCip95 = false }: WalletConnectionProps) {
  const [changing, setChanging] = useState(false);
  const current = wallets.find((w) => w.key === selected) ?? wallets[0];
  const canChange = wallets.length > 1;

  if (!current) return null;

  const missingCip95 = requiresCip95 && !current.supportsCip95;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        {current.icon ? (
          <img src={current.icon} alt="" width={32} height={32} style={{ width: 32, height: 32, borderRadius: '0.5rem', objectFit: 'contain', flexShrink: 0 }} />
        ) : (
          <span aria-hidden="true" style={monoStyle}>{monogram(current.name)}</span>
        )}
        <div style={{ minWidth: 0, flex: '1 1 10rem' }}>
          {label ? <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--muted)' }}>{label}</p> : null}
          <p style={{ margin: '0.1rem 0 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.name}</span>
            {current.supportsCip95 && <span style={badgeStyle}>CIP-95</span>}
          </p>
        </div>
        {canChange && (
          <button
            type="button"
            onClick={() => setChanging((c) => !c)}
            disabled={disabled}
            style={{ flexShrink: 0, background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '0.375rem', padding: '0.375rem 0.75rem', fontSize: '0.875rem', cursor: disabled ? 'not-allowed' : 'pointer' }}
          >
            {changing ? 'Cancel' : 'Change wallet'}
          </button>
        )}
      </div>

      {changing && (
        <div style={{ marginTop: '0.875rem' }}>
          <WalletPicker
            wallets={wallets}
            selected={selected}
            onSelect={(key) => {
              onSelect(key);
              setChanging(false);
            }}
            disabled={disabled}
            hideLabel
          />
        </div>
      )}

      {missingCip95 && (
        <div className="callout callout--warning" role="status" style={{ marginTop: '0.875rem' }}>
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div className="callout__body">
            {current.name} does not support CIP-95, which this action requires.{' '}
            {canChange
              ? 'Choose another wallet above.'
              : 'Use a DRep-capable wallet such as Eternl, Lace or Typhon.'}
          </div>
        </div>
      )}

      {note && (
        <p style={{ margin: '0.75rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>{note}</p>
      )}
    </div>
  );
}
