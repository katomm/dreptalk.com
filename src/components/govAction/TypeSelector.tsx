// The five action-type radio cards at the top of /ga/new. Presentational: it
// renders the type names, one sentence of what each one does, and the
// thresholds it has to clear, all supplied from outside. The threshold
// sentence comes from thresholds.ts, the single CIP-1694 threshold table, so
// the cards can never disagree with the Voting Information card on a GA page.
import type { CSSProperties } from 'react';
import type { GovActionFormType } from '@/lib/governance/prevAction.js';
import { thresholdSentence, decidersLine } from '@/lib/governance/thresholds.js';
import type { ProtocolParams } from '@/lib/db/protocolParams.js';
import type { DepositState } from '@/lib/governance/govActionFormState.js';
import { formatAdaPlain } from '@/lib/format/ada.js';

export interface TypeSelectorProps {
  value: GovActionFormType;
  onChange: (type: GovActionFormType) => void;
  /** Live protocol parameters for the threshold sentence, null while they load. */
  params: ProtocolParams | null;
  /** The same epoch_params fetch the island already runs, for the deposit line. No new fetch here. */
  deposit: DepositState;
  disabled?: boolean;
}

/** The deposit line under the threshold sentence, in the deposit fetch's three states. */
function depositLine(deposit: DepositState): string {
  if (deposit.status === 'loading') return 'Deposit: loading';
  if (deposit.status === 'error') return 'Deposit unavailable';
  return `Deposit ${formatAdaPlain(deposit.lovelace)} tADA, refunded when the action is finalized`;
}

const TYPES: { type: GovActionFormType; label: string; summary: string }[] = [
  {
    type: 'InfoAction',
    label: 'Info action',
    summary: 'Puts a question or a statement to a vote. It has no on-chain effect of its own.',
  },
  {
    type: 'NoConfidence',
    label: 'No confidence',
    summary: 'Removes the sitting constitutional committee and puts governance into a state of no confidence.',
  },
  {
    type: 'HardForkInitiation',
    label: 'Hard fork initiation',
    summary: 'Proposes moving the network to a new protocol version.',
  },
  {
    type: 'NewConstitution',
    label: 'New constitution',
    summary: 'Replaces the constitution document, and with it the optional guardrails script.',
  },
  {
    type: 'UpdateCommittee',
    label: 'Update committee',
    summary: 'Adds or removes constitutional committee members and sets the committee quorum.',
  },
];

const listStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.5rem' };

function cardStyle(selected: boolean, disabled: boolean): CSSProperties {
  return {
    display: 'flex',
    gap: '0.625rem',
    alignItems: 'flex-start',
    padding: '0.75rem',
    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: '0.5rem',
    background: 'var(--bg)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

export default function TypeSelector({ value, onChange, params, deposit, disabled = false }: TypeSelectorProps) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontSize: '0.875rem', color: 'var(--muted)', padding: 0, marginBottom: '0.5rem' }}>
        Action type
      </legend>
      <div style={listStyle}>
        {TYPES.map(t => (
          <label key={t.type} style={cardStyle(t.type === value, disabled)}>
            <input
              type="radio"
              name="ga-type"
              value={t.type}
              checked={t.type === value}
              disabled={disabled}
              onChange={() => onChange(t.type)}
              style={{ marginTop: '0.2rem', flexShrink: 0 }}
            />
            <span>
              <span style={{ display: 'block', fontWeight: 600 }}>{t.label}</span>
              <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                {t.summary}
              </span>
              <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
                {params
                  ? thresholdSentence(t.type, params)
                  : 'Loading the current voting thresholds...'}
              </span>
              <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                {depositLine(deposit)}
              </span>
              <span style={{ display: 'block', fontSize: '0.8125rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                {decidersLine(t.type)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
