// UpdateCommittee panel: the previous action, the members to remove and add,
// and the committee quorum. Presentational, every rule lives in
// committeeUpdate.ts and is reached through validateCommitteePanel, which the
// shell calls with the same panel state when it builds the action.
//
// Two shapes, depending on what the diff will be applied to: chained onto the
// enacted root it is today's committee, so removals are ticked off a list,
// while chained onto a proposal that is still open the committee at enactment
// is unknown, so removals become free credential rows.
import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import PrevActionField from './PrevActionField.js';
import { validateCommitteePanel } from '@/lib/governance/govActionFormState.js';
import type { CommitteeAddRow, UpdateCommitteePanelState } from '@/lib/governance/govActionFormState.js';
import type { ActionContextResponse } from '@/lib/governance/actionContextHandler.js';
import { inputStyle } from '@/components/drepFormStyles.js';

export interface UpdateCommitteePanelProps {
  context: ActionContextResponse;
  value: UpdateCommitteePanelState;
  onChange: (value: UpdateCommitteePanelState) => void;
  disabled?: boolean;
}

const mutedStyle: CSSProperties = { color: 'var(--muted)', fontSize: '0.8125rem' };
const labelStyle: CSSProperties = { display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem', color: 'var(--muted)' };
const errorStyle: CSSProperties = { margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--danger, #b3261e)' };
const rowStyle: CSSProperties = { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' };
const linkButtonStyle = (disabled: boolean): CSSProperties => ({
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '0.8125rem',
  padding: '0 0.25rem',
  textDecoration: 'underline',
});

/** True for input the parser reads as CIP-129 bech32, where the header byte already says key or script. */
function isBech32Credential(input: string): boolean {
  return /^cc_cold1/i.test(input.trim());
}

function shortHex(hex: string): string {
  return `${hex.slice(0, 12)}...${hex.slice(-6)}`;
}

/** The key/script toggle, disabled and irrelevant while the input is bech32. */
function KindToggle(props: {
  value: 'key' | 'script';
  onChange: (kind: 'key' | 'script') => void;
  input: string;
  disabled: boolean;
  label: string;
}) {
  const auto = isBech32Credential(props.input);
  return (
    <select
      value={props.value}
      onChange={e => props.onChange(e.target.value === 'script' ? 'script' : 'key')}
      disabled={props.disabled || auto}
      aria-label={props.label}
      style={{ ...inputStyle, width: 'auto', flexShrink: 0 }}
      title={auto ? 'A cc_cold credential says itself whether it is a key or a script hash.' : undefined}
    >
      <option value="key">Key hash</option>
      <option value="script">Script hash</option>
    </select>
  );
}

export default function UpdateCommitteePanel({ context, value, onChange, disabled = false }: UpdateCommitteePanelProps) {
  const prevContext = context.prev ?? { lastEnacted: null, open: [] };
  const committee = context.committee ?? null;
  const members = committee?.members ?? [];
  const maxTermLength = committee?.maxTermLength ?? null;
  const defaultExpiry = maxTermLength == null ? '' : String(context.epoch + maxTermLength);

  // Prefill the quorum from the committee in force, once, so a user who
  // cleared a field is not fought by the effect on the next render.
  const prefilledRef = useRef(false);
  const contextQuorum = committee?.quorum ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a one-shot prefill on the context value, not a sync of the fields
  useEffect(() => {
    if (prefilledRef.current || !contextQuorum) return;
    prefilledRef.current = true;
    if (value.quorum === null) {
      onChange({
        ...value,
        quorum: { numerator: String(contextQuorum.numerator), denominator: String(contextQuorum.denominator) },
      });
    }
  }, [contextQuorum]);

  const result = useMemo(() => validateCommitteePanel(value, context), [value, context]);
  const open = result.mode === 'open';
  const errorFor = (field: string) => result.errors.find(e => e.field === field)?.message;
  const warningFor = (field: string) => result.warnings.find(w => w.field === field)?.message;

  const quorumNumerator = value.quorum?.numerator ?? '';
  const quorumDenominator = value.quorum?.denominator ?? '';
  const quorumPct =
    result.value && result.value.quorum.denominator > 0
      ? `${Math.round((result.value.quorum.numerator / result.value.quorum.denominator) * 1000) / 10}%`
      : null;

  function setQuorum(patch: { numerator?: string; denominator?: string }) {
    onChange({
      ...value,
      quorum: { numerator: quorumNumerator, denominator: quorumDenominator, ...patch },
    });
  }
  function updateAddRow(i: number, patch: Partial<CommitteeAddRow>) {
    onChange({ ...value, add: value.add.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <PrevActionField
        context={prevContext}
        value={value.prev}
        onChange={prev => onChange({ ...value, prev })}
        disabled={disabled}
      />

      {open && (
        <p style={{ ...mutedStyle, margin: 0 }}>
          Chained onto a proposal that is still open, so the committee this diff will be applied to is the one that
          proposal leaves behind, not the one sitting today. Today&apos;s members are offered below as suggestions
          only, and the quorum shown is today&apos;s.
        </p>
      )}

      <div>
        <span style={labelStyle}>Members to remove</span>
        {!open &&
          (members.length === 0 ? (
            <p style={{ ...mutedStyle, margin: 0 }}>There is no committee on record to remove members from.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {members.map(m =>
                m.coldHex === null ? null : (
                  <label key={m.coldHex} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.875rem' }}>
                    <input
                      type="checkbox"
                      checked={value.removeHex.includes(m.coldHex)}
                      disabled={disabled}
                      onChange={e =>
                        onChange({
                          ...value,
                          removeHex: e.target.checked
                            ? [...value.removeHex, m.coldHex as string]
                            : value.removeHex.filter(h => h !== m.coldHex),
                        })
                      }
                    />
                    <span>
                      {shortHex(m.coldHex)}{' '}
                      <span style={mutedStyle}>
                        ({m.hasScript ? 'script hash' : 'key hash'}
                        {m.expirationEpoch == null ? '' : `, term ends in epoch ${m.expirationEpoch}`})
                      </span>
                    </span>
                  </label>
                ),
              )}
            </div>
          ))}
        {open && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {value.removeFree.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional inputs owned by index, there is no stable id
              <div key={i}>
                <div style={rowStyle}>
                  <input
                    type="text"
                    value={row.input}
                    onChange={e =>
                      onChange({
                        ...value,
                        removeFree: value.removeFree.map((r, idx) => (idx === i ? { ...r, input: e.target.value } : r)),
                      })
                    }
                    placeholder="cc_cold... or 56 hex characters"
                    disabled={disabled}
                    list="ga-committee-members"
                    spellCheck={false}
                    style={{ ...inputStyle, flex: 1, minWidth: '14rem' }}
                    aria-label={`Credential to remove ${i + 1}`}
                  />
                  <KindToggle
                    value={row.hexKind}
                    input={row.input}
                    disabled={disabled}
                    label={`Credential kind for removal ${i + 1}`}
                    onChange={hexKind =>
                      onChange({
                        ...value,
                        removeFree: value.removeFree.map((r, idx) => (idx === i ? { ...r, hexKind } : r)),
                      })
                    }
                  />
                  <button
                    type="button"
                    onClick={() => onChange({ ...value, removeFree: value.removeFree.filter((_, idx) => idx !== i) })}
                    disabled={disabled}
                    style={linkButtonStyle(disabled)}
                  >
                    Remove row
                  </button>
                </div>
                {errorFor(`remove[${i}]`) && <p style={errorStyle}>{errorFor(`remove[${i}]`)}</p>}
              </div>
            ))}
            <datalist id="ga-committee-members">
              {members.map(m => (m.coldHex === null ? null : <option key={m.coldHex} value={m.coldHex} />))}
            </datalist>
            <div>
              <button
                type="button"
                onClick={() => onChange({ ...value, removeFree: [...value.removeFree, { input: '', hexKind: 'key' }] })}
                disabled={disabled}
                style={{ background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '0.375rem', padding: '0.375rem 0.75rem', fontSize: '0.875rem', cursor: disabled ? 'not-allowed' : 'pointer' }}
              >
                Add a credential to remove
              </button>
            </div>
          </div>
        )}
        {!open &&
          value.removeHex.map((_, i) =>
            errorFor(`remove[${i}]`) ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the error is positional, keyed by the same index the validator reports
              <p key={i} style={errorStyle}>
                {errorFor(`remove[${i}]`)}
              </p>
            ) : null,
          )}
      </div>

      <div>
        <span style={labelStyle}>Members to add</span>
        <span style={{ ...mutedStyle, display: 'block', margin: '0 0 0.375rem' }}>
          A cold credential as CIP-129 bech32 (cc_cold...) or 56 hex characters, plus the epoch its term ends.
          {maxTermLength == null
            ? ''
            : ` The term cannot run past epoch ${context.epoch + maxTermLength}, the maximum term from here.`}
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {value.add.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional inputs owned by index, there is no stable id
            <div key={i}>
              <div style={rowStyle}>
                <input
                  type="text"
                  value={row.input}
                  onChange={e => updateAddRow(i, { input: e.target.value })}
                  placeholder="cc_cold... or 56 hex characters"
                  disabled={disabled}
                  spellCheck={false}
                  style={{ ...inputStyle, flex: 1, minWidth: '14rem' }}
                  aria-label={`Credential to add ${i + 1}`}
                />
                <KindToggle
                  value={row.hexKind}
                  input={row.input}
                  disabled={disabled}
                  label={`Credential kind for addition ${i + 1}`}
                  onChange={hexKind => updateAddRow(i, { hexKind })}
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={row.expiryEpoch}
                  onChange={e => updateAddRow(i, { expiryEpoch: e.target.value })}
                  placeholder="Expiry epoch"
                  disabled={disabled}
                  style={{ ...inputStyle, width: '8rem', flexShrink: 0 }}
                  aria-label={`Expiry epoch for addition ${i + 1}`}
                />
                <button
                  type="button"
                  onClick={() => onChange({ ...value, add: value.add.filter((_, idx) => idx !== i) })}
                  disabled={disabled}
                  style={linkButtonStyle(disabled)}
                >
                  Remove row
                </button>
              </div>
              {errorFor(`add[${i}].credential`) && <p style={errorStyle}>{errorFor(`add[${i}].credential`)}</p>}
              {errorFor(`add[${i}].expiryEpoch`) && <p style={errorStyle}>{errorFor(`add[${i}].expiryEpoch`)}</p>}
              {warningFor(`add[${i}].credential`) && <p style={{ ...mutedStyle, margin: '0.25rem 0 0' }}>{warningFor(`add[${i}].credential`)}</p>}
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={() =>
                onChange({ ...value, add: [...value.add, { input: '', hexKind: 'key', expiryEpoch: defaultExpiry }] })
              }
              disabled={disabled}
              style={{ background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '0.375rem', padding: '0.375rem 0.75rem', fontSize: '0.875rem', cursor: disabled ? 'not-allowed' : 'pointer' }}
            >
              Add a member
            </button>
          </div>
        </div>
      </div>

      <div>
        <span style={labelStyle}>Committee quorum</span>
        <span style={{ ...mutedStyle, display: 'block', margin: '0 0 0.375rem' }}>
          The share of the committee that has to vote yes. Set as a fraction.
        </span>
        <div style={rowStyle}>
          <input
            type="text"
            inputMode="numeric"
            value={quorumNumerator}
            onChange={e => setQuorum({ numerator: e.target.value })}
            disabled={disabled}
            style={{ ...inputStyle, width: '5rem', flexShrink: 0 }}
            aria-label="Quorum numerator"
          />
          <span aria-hidden="true">/</span>
          <input
            type="text"
            inputMode="numeric"
            value={quorumDenominator}
            onChange={e => setQuorum({ denominator: e.target.value })}
            disabled={disabled}
            style={{ ...inputStyle, width: '5rem', flexShrink: 0 }}
            aria-label="Quorum denominator"
          />
          {quorumPct && <span style={mutedStyle}>{quorumPct}</span>}
        </div>
        {errorFor('quorum.numerator') && <p style={errorStyle}>{errorFor('quorum.numerator')}</p>}
        {errorFor('quorum.denominator') && <p style={errorStyle}>{errorFor('quorum.denominator')}</p>}
      </div>

      {errorFor('changes') && <p style={errorStyle}>This proposal changes nothing. Adjust the members or the quorum.</p>}
    </div>
  );
}
