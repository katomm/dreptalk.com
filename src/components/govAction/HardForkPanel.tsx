// HardForkInitiation panel: the previous action plus the protocol version to
// propose. Presentational, the version rules live in hardForkVersion.ts.
//
// The base the candidates are computed from is the ledger's own rule
// (preceedingHardFork): a proposal chained onto an open hard fork proposal is
// checked against that proposal's version, everything else against the
// version currently active.
import type { CSSProperties } from 'react';
import PrevActionField from './PrevActionField.js';
import { versionsThatFollow, type ProtocolVersion } from '@/lib/governance/hardForkVersion.js';
import type { GovActionRef } from '@/lib/governance/prevAction.js';
import type { ActionContextResponse } from '@/lib/governance/actionContextHandler.js';
import type { HardForkPanelState } from '@/lib/governance/govActionFormState.js';

export interface HardForkPanelProps {
  context: ActionContextResponse;
  value: HardForkPanelState;
  onChange: (value: HardForkPanelState) => void;
  disabled?: boolean;
}

const mutedStyle: CSSProperties = { color: 'var(--muted)', fontSize: '0.8125rem' };
const labelStyle: CSSProperties = { display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem', color: 'var(--muted)' };

function formatVersion(v: ProtocolVersion): string {
  return `${v.major}.${v.minor}`;
}

function sameVersion(a: ProtocolVersion | null, b: ProtocolVersion): boolean {
  return a !== null && a.major === b.major && a.minor === b.minor;
}

/** The open row the chosen prev points at, when the choice is an open proposal rather than the chain root. */
function chosenOpenRow(value: HardForkPanelState, open: GovActionRef[]): GovActionRef | null {
  if (!value.prev) return null;
  const hash = value.prev.txHashHex.toLowerCase();
  return open.find(o => o.txHash.toLowerCase() === hash && o.index === value.prev?.index) ?? null;
}

export default function HardForkPanel({ context, value, onChange, disabled = false }: HardForkPanelProps) {
  const prevContext = context.prev ?? { lastEnacted: null, open: [] };
  const active = context.protocolVersion ?? null;
  const openRow = chosenOpenRow(value, prevContext.open);
  const base = openRow ? (openRow.version ?? null) : active;
  const candidates = base && active ? versionsThatFollow(base, active) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <PrevActionField
        context={prevContext}
        value={value.prev}
        onChange={prev => onChange({ ...value, prev, version: null })}
        disabled={disabled}
      />

      <div>
        <span style={labelStyle}>Protocol version</span>
        {active && (
          <p style={{ ...mutedStyle, margin: '0 0 0.375rem' }}>
            The network is on {formatVersion(active)}
            {openRow?.version ? `, and the chosen open proposal would take it to ${formatVersion(openRow.version)}` : ''}.
          </p>
        )}
        {!active && (
          <p style={{ ...mutedStyle, margin: 0 }}>
            The current protocol version could not be read from the chain, so no version can be offered. Reload the
            page to try again.
          </p>
        )}
        {active && openRow && !openRow.version && (
          <p style={{ ...mutedStyle, margin: 0 }}>
            The protocol version of the chosen open proposal could not be read from its on-chain payload, so no
            version can be offered against it. Chain onto the last enacted action instead.
          </p>
        )}
        {candidates.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {candidates.map(c => (
              <label key={formatVersion(c)} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.875rem' }}>
                <input
                  type="radio"
                  name="ga-hard-fork-version"
                  checked={sameVersion(value.version, c)}
                  disabled={disabled}
                  onChange={() => onChange({ ...value, version: c })}
                />
                <span>
                  {formatVersion(c)}{' '}
                  <span style={mutedStyle}>({c.minor === 0 ? 'major version bump' : 'minor version bump'})</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
