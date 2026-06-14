// Controlled row editor for DRep profile links. Each row is a { label, uri }
// pair; the parent owns the array. Up to MAX rows; an empty trailing row is the
// "add" affordance through the explicit Add button.
import type { CSSProperties } from 'react';
import { inputStyle as baseInputStyle } from '@/components/drepFormStyles.js';

export interface ProfileLink {
  label: string;
  uri: string;
}

interface DrepLinksEditorProps {
  value: ProfileLink[];
  onChange: (links: ProfileLink[]) => void;
  disabled?: boolean;
  max?: number;
}

// The shared field style, a touch smaller for these in-row inputs. Flex sizing
// on each input overrides the base width.
const inputStyle: CSSProperties = { ...baseInputStyle, fontSize: '0.9375rem' };

export default function DrepLinksEditor({ value, onChange, disabled, max = 10 }: DrepLinksEditorProps) {
  function update(i: number, patch: Partial<ProfileLink>) {
    onChange(value.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add() {
    if (value.length < max) onChange([...value, { label: '', uri: '' }]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {value.map((link, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional inputs the parent owns by index; there is no stable id
        <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="text"
            value={link.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder="Label (e.g. Website)"
            maxLength={80}
            disabled={disabled}
            style={{ ...inputStyle, flex: '0 0 9rem' }}
            aria-label={`Link ${i + 1} label`}
          />
          <input
            type="url"
            value={link.uri}
            onChange={(e) => update(i, { uri: e.target.value })}
            placeholder="https://..."
            disabled={disabled}
            style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            aria-label={`Link ${i + 1} URL`}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={disabled}
            aria-label={`Remove link ${i + 1}`}
            title="Remove link"
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', lineHeight: 0, padding: '0 0.25rem', flexShrink: 0 }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        </div>
      ))}
      {value.length < max && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <button
            type="button"
            onClick={add}
            disabled={disabled}
            style={{ background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '0.375rem', padding: '0.375rem 0.75rem', fontSize: '0.875rem', cursor: disabled ? 'not-allowed' : 'pointer' }}
          >
            Add link
          </button>
          <span style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>You can add up to {max} links.</span>
        </div>
      )}
    </div>
  );
}
