// Controlled row editor for DRep profile links. Each row is a { label, uri }
// pair; the parent owns the array. Up to MAX rows; an empty trailing row is the
// "add" affordance through the explicit Add button.
import type { CSSProperties } from 'react';

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

const inputStyle: CSSProperties = {
  padding: '0.5rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: '0.375rem',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: '0.9375rem',
};

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
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1.25rem', lineHeight: 1, padding: '0 0.25rem' }}
          >
            &times;
          </button>
        </div>
      ))}
      {value.length < max && (
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          style={{ alignSelf: 'flex-start', background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '0.375rem', padding: '0.375rem 0.75rem', fontSize: '0.875rem', cursor: disabled ? 'not-allowed' : 'pointer' }}
        >
          Add link
        </button>
      )}
    </div>
  );
}
