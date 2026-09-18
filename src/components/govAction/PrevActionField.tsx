// The previous-action field every chained action type needs (CIP-1694 purpose
// chains). Read-only by default: it shows the chain's last enacted action,
// which is what the ledger expects, and hides the alternative behind an
// Advanced disclosure for the rarer case of chaining onto a proposal that is
// still open.
//
// `value` is the user's explicit pick. null means "the chain root shown
// here", which is resolved to a concrete ref by effectivePrev() at submit
// time, so a root that moves while the page is open is caught by the
// submit-time freshness check instead of being followed silently.
import type { CSSProperties } from 'react';
import type { PrevActionRef, GovActionRef } from '@/lib/governance/prevAction.js';

export interface PrevActionFieldProps {
  context: { lastEnacted: GovActionRef | null; open: GovActionRef[] };
  value: PrevActionRef | null;
  onChange: (value: PrevActionRef | null) => void;
  disabled?: boolean;
}

// The context route's own display cap on the open list, mirrored here so the
// field can say it is showing a window rather than the whole chain.
const OPEN_DISPLAY_CAP = 50;

const labelStyle: CSSProperties = { display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem', color: 'var(--muted)' };
const rowStyle: CSSProperties = { fontSize: '0.875rem', lineHeight: 1.5 };
const mutedStyle: CSSProperties = { color: 'var(--muted)', fontSize: '0.8125rem' };

function refLabel(ref: GovActionRef): string {
  return ref.title ?? `${ref.id.slice(0, 16)}...`;
}

function sameRef(a: PrevActionRef | null, b: GovActionRef): boolean {
  return a !== null && a.txHashHex.toLowerCase() === b.txHash.toLowerCase() && a.index === b.index;
}

function RefLine({ action }: { action: GovActionRef }) {
  return (
    <>
      <a href={`/ga/${action.id}/`} style={{ color: 'var(--accent)' }}>
        {refLabel(action)}
      </a>{' '}
      <span style={mutedStyle}>
        ({action.type}, proposed in epoch {action.proposedEpoch})
      </span>
    </>
  );
}

export default function PrevActionField({ context, value, onChange, disabled = false }: PrevActionFieldProps) {
  const { lastEnacted, open } = context;
  return (
    <div>
      <span style={labelStyle}>Previous action</span>
      <p style={{ ...rowStyle, margin: '0 0 0.5rem' }}>
        {lastEnacted ? <RefLine action={lastEnacted} /> : <span>None, this starts the chain.</span>}
      </p>

      <details>
        <summary style={{ cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '0.875rem', color: 'var(--accent)' }}>
          Advanced: chain onto an open proposal
        </summary>
        <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          <p style={{ ...mutedStyle, margin: 0 }}>
            Chaining onto an open proposal only enacts if that proposal is enacted first. Leave this on the last
            enacted action unless you know you need it.
          </p>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.875rem' }}>
            <input
              type="radio"
              name="ga-prev-action"
              checked={value === null}
              disabled={disabled}
              onChange={() => onChange(null)}
              style={{ marginTop: '0.2rem' }}
            />
            <span>{lastEnacted ? 'Last enacted action (default)' : 'No previous action (default)'}</span>
          </label>
          {open.length === 0 ? (
            <p style={{ ...mutedStyle, margin: 0 }}>No open proposals in this chain.</p>
          ) : (
            open.map(o => (
              <label
                key={`${o.txHash}#${o.index}`}
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.875rem' }}
              >
                <input
                  type="radio"
                  name="ga-prev-action"
                  checked={sameRef(value, o)}
                  disabled={disabled}
                  onChange={() => onChange({ txHashHex: o.txHash, index: o.index })}
                  style={{ marginTop: '0.2rem' }}
                />
                <span>
                  <RefLine action={o} />
                </span>
              </label>
            ))
          )}
          {open.length === OPEN_DISPLAY_CAP && (
            <p style={{ ...mutedStyle, margin: 0 }}>Showing the {OPEN_DISPLAY_CAP} newest open proposals.</p>
          )}
        </div>
      </details>
    </div>
  );
}
