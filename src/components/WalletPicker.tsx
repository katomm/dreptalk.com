// Shared wallet picker for every CIP-30 flow (login, registration, settings,
// delegation). A native <select> cannot render the wallet logo each CIP-30
// extension exposes (icon is a data URI), so this is a list of real radio
// options styled as rows: logo, name, and a CIP-95 badge, with the selected
// row marked. Real radios give native keyboard (arrow) navigation and screen
// reader support; it only reports the chosen key, connecting stays with each
// flow's own button.
import { useId, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CardanoWalletInfo } from '@/lib/wallet/useCardanoWallets.js';

interface WalletPickerProps {
  wallets: CardanoWalletInfo[];
  /** Currently selected wallet key. */
  selected: string;
  onSelect: (key: string) => void;
  disabled?: boolean;
  /** Field label above the list. Defaults to "Wallet". */
  label?: string;
}

const rowBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  width: '100%',
  padding: '0.5rem 0.625rem',
  borderRadius: '0.5rem',
  background: 'var(--bg)',
  margin: 0,
};

// Visually hidden but focusable: the styled <label> is the visible control, the
// native radio drives selection, keyboard, and assistive tech.
const srOnlyRadio: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: 0,
  opacity: 0,
  pointerEvents: 'none',
};

/** First letter of the wallet name, used when the extension exposes no icon. */
function monogram(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export default function WalletPicker({ wallets, selected, onSelect, disabled, label = 'Wallet' }: WalletPickerProps) {
  const groupName = useId();
  const [focused, setFocused] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>{label}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        {wallets.map((w) => {
          const isSelected = w.key === selected;
          const isFocused = focused === w.key;
          return (
            <label
              key={w.key}
              style={{
                ...rowBase,
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                boxShadow: isSelected ? '0 0 0 1px var(--accent)' : 'none',
                outline: isFocused ? '2px solid var(--accent)' : 'none',
                outlineOffset: 2,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.7 : 1,
              }}
            >
              <input
                type="radio"
                name={groupName}
                value={w.key}
                checked={isSelected}
                disabled={disabled}
                onChange={() => onSelect(w.key)}
                onFocus={() => setFocused(w.key)}
                onBlur={() => setFocused(null)}
                style={srOnlyRadio}
              />

              {w.icon ? (
                <img
                  src={w.icon}
                  alt=""
                  width={28}
                  height={28}
                  style={{ borderRadius: '0.375rem', objectFit: 'contain', flexShrink: 0 }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    width: 28,
                    height: 28,
                    flexShrink: 0,
                    borderRadius: '0.375rem',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: 'var(--muted)',
                  }}
                >
                  {monogram(w.name)}
                </span>
              )}

              <span style={{ flex: 1, minWidth: 0, fontWeight: 500, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {w.name}
              </span>

              {w.supportsCip95 && (
                <span
                  style={{
                    fontSize: '0.6875rem',
                    fontWeight: 600,
                    color: 'var(--muted)',
                    border: '1px solid var(--border)',
                    borderRadius: '999px',
                    padding: '0.05rem 0.4rem',
                    flexShrink: 0,
                  }}
                >
                  CIP-95
                </span>
              )}

              {isSelected && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
