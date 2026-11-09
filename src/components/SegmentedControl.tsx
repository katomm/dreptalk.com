// Two-or-more button toggle shared by the sign-in choices and the DRep group management tasks.
import type { ReactNode } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

// Two-or-more button toggle for role and method choices. Active state is a
// subtle tint, not a solid fill, so it never competes with the primary button.
//
// `wrap` + `minButtonInlineSize` are opt-in: only the three-way sign-in method
// control needs to stack on narrow screens, so the two-and-three-way role
// controls (which already fit comfortably) keep their original single-row layout.
export default function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  wrap = false,
  minButtonInlineSize,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  disabled?: boolean;
  ariaLabel: string;
  wrap?: boolean;
  minButtonInlineSize?: string;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        flexWrap: wrap ? 'wrap' : 'nowrap',
        gap: '0.25rem',
        margin: 0,
        minInlineSize: 0,
        padding: '0.25rem',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm, 9px)',
        background: 'var(--surface)',
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            disabled={disabled}
            aria-pressed={active}
            style={{
              flex: 1,
              minInlineSize: minButtonInlineSize,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.45rem',
              border: 'none',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: '0.9375rem',
              fontWeight: active ? 600 : 500,
              fontFamily: 'inherit',
              background: active ? 'color-mix(in srgb, var(--accent) 12%, var(--bg))' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--muted)',
              boxShadow: active ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent)' : 'none',
              transition: 'background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}
