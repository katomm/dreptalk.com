// UpdateCommittee panel: the previous action, the members to remove and add,
// and the committee quorum. Presentational, every rule lives in
// committeeUpdate.ts and is reached through validateCommitteePanel, which the
// shell calls with the same panel state when it builds the action.
//
// Two shapes, depending on what the diff will be applied to: chained onto the
// enacted root it is today's committee, so removals are ticked off a list,
// while chained onto a proposal that is still open the committee at enactment
// is unknown, so removals become free credential rows.
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import PrevActionField from './PrevActionField.js';
import { validateCommitteePanel } from '@/lib/governance/govActionFormState.js';
import { ccColdBech32, isBech32CredentialInput } from '@/lib/governance/committeeUpdate.js';
import { epochDateClause, epochWithDate } from '@/lib/governance/epochLabel.js';
import type { CommitteeAddRow, UpdateCommitteePanelState } from '@/lib/governance/govActionFormState.js';
import type { ActionContextResponse } from '@/lib/governance/actionContextHandler.js';
import type { NetworkConfig } from '@/lib/config/network.js';
import { inputStyle, labelStyle, mutedStyle } from '@/components/drepFormStyles.js';

export interface UpdateCommitteePanelProps {
  context: ActionContextResponse;
  value: UpdateCommitteePanelState;
  onChange: (value: UpdateCommitteePanelState) => void;
  networkConfig: NetworkConfig;
  disabled?: boolean;
}

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

/** The first 8 and last 6 characters of an id, joined by an ellipsis. */
function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

/**
 * A member's cold credential as shortened cc_cold bech32, or, when the chain
 * context hands back a hash that is not 56 hex characters, the shortened hex
 * it did hand back. The members come from upstream, so an unencodable hash is
 * shown as what it is rather than allowed to take the panel down.
 */
function shortColdCredential(coldHex: string, hasScript: boolean): string {
  return shortId(ccColdBech32(coldHex, hasScript) ?? coldHex);
}

/**
 * A sitting member's checkbox label: its self-declared or curated display
 * name (when known) followed by the shortened cc_cold bech32 credential and
 * the term expiry with its calendar date, or the shortened credential alone
 * when there is no name. The kind (key vs script) is not spelled out
 * separately, the bech32 header byte already carries it.
 */
function committeeMemberLabel(
  member: { coldHex: string; hasScript: boolean; expirationEpoch: number | null; name: string | null },
  networkConfig: NetworkConfig,
): string {
  const short = shortColdCredential(member.coldHex, member.hasScript);
  const expiry =
    member.expirationEpoch == null
      ? ''
      : `, term ends in epoch ${member.expirationEpoch}, ${epochDateClause(member.expirationEpoch, networkConfig)}`;
  return member.name ? `${member.name} (${short}${expiry})` : `${short}${expiry}`;
}

/** The key/script toggle, disabled and irrelevant while the input is bech32. */
function KindToggle(props: {
  value: 'key' | 'script';
  onChange: (kind: 'key' | 'script') => void;
  input: string;
  disabled: boolean;
  label: string;
}) {
  const auto = isBech32CredentialInput(props.input);
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

export default function UpdateCommitteePanel({ context, value, onChange, networkConfig, disabled = false }: UpdateCommitteePanelProps) {
  const prevContext = context.prev ?? { lastEnacted: null, open: [] };
  const committee = context.committee ?? null;
  const members = committee?.members ?? [];
  const maxTermLength = committee?.maxTermLength ?? null;
  const defaultExpiry = maxTermLength == null ? '' : String(context.epoch + maxTermLength);

  const contextQuorum = committee?.quorum ?? null;

  const result = useMemo(() => validateCommitteePanel(value, context), [value, context]);
  const open = result.mode === 'open';
  const errorFor = (field: string) => result.errors.find(e => e.field === field)?.message;
  const warningFor = (field: string) => result.warnings.find(w => w.field === field)?.message;

  // The quorum in force is shown as the default rather than written into the
  // state by an effect: any other edit in the same tick would be built on a
  // state without it and would silently drop it again. validateCommitteePanel
  // applies the same fallback, so the fields and the action agree.
  const quorumNumerator = value.quorum?.numerator ?? (contextQuorum ? String(contextQuorum.numerator) : '');
  const quorumDenominator = value.quorum?.denominator ?? (contextQuorum ? String(contextQuorum.denominator) : '');
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
        networkConfig={networkConfig}
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
                      value={m.coldHex}
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
                    <span>{committeeMemberLabel({ ...m, coldHex: m.coldHex }, networkConfig)}</span>
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
              {/* A member whose cold hash does not encode is left out rather
                  than offered as a suggestion the credential parser would
                  refuse anyway. */}
              {members.map(m => {
                const bech32 = m.coldHex === null ? null : ccColdBech32(m.coldHex, m.hasScript);
                return bech32 === null ? null : <option key={m.coldHex} value={bech32} />;
              })}
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
            : ` The term cannot run past ${epochWithDate(context.epoch + maxTermLength, networkConfig)}, the maximum term from here.`}
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
                  list="ga-committee-members"
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
