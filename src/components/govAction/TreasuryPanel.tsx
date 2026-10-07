// TreasuryWithdrawals panel: the recipient rows (stake address plus amount in
// ada), each row's registration state, the guardrail block and the total.
// Presentational: the rules live in treasuryWithdrawals.ts, the registration
// answers in the reducer (govActionFormState.ts).
import type { CSSProperties } from 'react';
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { RecipientCheckState, TreasuryPanelState } from '@/lib/governance/govActionFormState.js';
import {
  checkTreasuryRows,
  EMPTY_TREASURY_ROW,
  formatLovelaceExact,
  RECIPIENT_UNREGISTERED,
  TREASURY_RECIPIENTS_MAX,
} from '@/lib/governance/treasuryWithdrawals.js';
import { guardrailDecision, type GuardrailContext } from '@/lib/governance/guardrailScript.js';
import { inputStyle, labelStyle, linkButtonStyle, mutedStyle } from '@/components/drepFormStyles.js';
import { ErrorIcon } from '@/components/govAction/icons.js';

export interface TreasuryPanelProps {
  value: TreasuryPanelState;
  onChange: (value: TreasuryPanelState) => void;
  network: CardanoNetwork;
  /** The guardrail the context reported, undefined when there is none. */
  guardrail: GuardrailContext | undefined;
  recipients: RecipientCheckState;
  /** Runs the registration check again after a failed lookup. */
  onRetryRecipients: () => void;
  disabled?: boolean;
}

const errorStyle: CSSProperties = { margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--danger, #b3261e)' };
const noteStyle: CSSProperties = { ...mutedStyle, margin: '0.25rem 0 0' };
const rowButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  fontSize: '0.8125rem',
  padding: '0 0.25rem',
  flexShrink: 0,
  textDecoration: 'underline',
};

export default function TreasuryPanel({
  value,
  onChange,
  network,
  guardrail,
  recipients,
  onRetryRecipients,
  disabled = false,
}: TreasuryPanelProps) {
  const rows = value.rows;
  const checked = checkTreasuryRows(rows, network);
  const decision = guardrailDecision(guardrail);

  function updateRow(i: number, patch: Partial<TreasuryPanelState['rows'][number]>) {
    onChange({ rows: rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)) });
  }
  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    // The panel always keeps one row to type into, as a fresh form does.
    onChange({ rows: next.length > 0 ? next : [EMPTY_TREASURY_ROW] });
  }
  function addRow() {
    if (rows.length >= TREASURY_RECIPIENTS_MAX) return;
    onChange({ rows: [...rows, EMPTY_TREASURY_ROW] });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {!decision.ok && (
        <div className="callout callout--error" role="alert">
          <ErrorIcon />
          <div className="callout__body">{decision.message}</div>
        </div>
      )}
      <span style={labelStyle}>Recipients</span>
      {rows.map((row, i) => {
        const check = checked.rows[i];
        const status = check?.address ? recipients.byAddress[check.address.stakeAddress] : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional inputs owned by index, there is no stable id
          <div key={i}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                aria-label={`Recipient ${i + 1} stake address`}
                value={row.address}
                onChange={(e) => updateRow(i, { address: e.target.value })}
                placeholder="stake_test1..."
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Recipient ${i + 1} amount in tADA`}
                value={row.amountAda}
                onChange={(e) => updateRow(i, { amountAda: e.target.value })}
                placeholder="tADA"
                disabled={disabled}
                style={{ ...inputStyle, flex: '0 0 9rem' }}
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={disabled}
                aria-label={`Remove recipient ${i + 1}`}
                style={{ ...rowButtonStyle, cursor: disabled ? 'not-allowed' : 'pointer' }}
              >
                Remove
              </button>
            </div>
            {row.address.trim() !== '' && check?.addressError && <p style={errorStyle}>{check.addressError}</p>}
            {row.amountAda.trim() !== '' && check?.amountError && <p style={errorStyle}>{check.amountError}</p>}
            {status === 'checking' && <p style={noteStyle}>Checking whether this stake address is registered...</p>}
            {status === 'unregistered' && <p style={errorStyle}>{RECIPIENT_UNREGISTERED}</p>}
            {status === 'failed' && (
              <p style={errorStyle}>
                Could not check whether this stake address is registered.{' '}
                <button type="button" onClick={onRetryRecipients} style={linkButtonStyle}>
                  Try again
                </button>
              </p>
            )}
          </div>
        );
      })}
      {rows.length < TREASURY_RECIPIENTS_MAX && (
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          style={{
            alignSelf: 'flex-start',
            background: 'transparent',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            borderRadius: '0.375rem',
            padding: '0.375rem 0.75rem',
            fontSize: '0.875rem',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          Add recipient
        </button>
      )}
      <p style={{ ...mutedStyle, margin: 0 }}>Total {formatLovelaceExact(checked.totalLovelace)} tADA</p>
      <p style={{ ...mutedStyle, margin: 0 }}>
        Up to {TREASURY_RECIPIENTS_MAX} recipients. Every recipient needs a registered stake address.
      </p>
    </div>
  );
}
