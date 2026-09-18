// NewConstitution panel: the previous action, the constitution document
// itself, and the optional guardrails script hash. Presentational, with the
// two checks that can be made off chain (the byte cap and the hex shape) done
// inline, because nothing else about a constitution is checkable here.
import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import PrevActionField from './PrevActionField.js';
import { CONSTITUTION_DOCUMENT_MAX_BYTES } from '@/lib/governance/infoActionLimits.js';
import type { ActionContextResponse } from '@/lib/governance/actionContextHandler.js';
import type { NewConstitutionPanelState } from '@/lib/governance/govActionFormState.js';
import { inputStyle } from '@/components/drepFormStyles.js';

export interface NewConstitutionPanelProps {
  context: ActionContextResponse;
  value: NewConstitutionPanelState;
  onChange: (value: NewConstitutionPanelState) => void;
  disabled?: boolean;
}

const mutedStyle: CSSProperties = { color: 'var(--muted)', fontSize: '0.8125rem' };
const labelStyle: CSSProperties = { display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem', color: 'var(--muted)' };
const textAreaStyle: CSSProperties = { ...inputStyle, lineHeight: '1.6', resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: '0.875rem' };

const SCRIPT_HASH_RE = /^[0-9a-f]{56}$/i;
const ENCODER = new TextEncoder();

/** Human-readable size for the byte counter, kept to whole KiB above a kilobyte. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${Math.round(bytes / 1024)} KiB`;
}

export default function NewConstitutionPanel({ context, value, onChange, disabled = false }: NewConstitutionPanelProps) {
  const prevContext = context.prev ?? { lastEnacted: null, open: [] };
  const contextScriptHash = context.constitution?.scriptHash ?? null;

  // Prefill the guardrails hash from the constitution in force, once, and only
  // into an untouched field: re-running it would fight a user who cleared the
  // field on purpose to propose a constitution without a script.
  const prefilledRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a one-shot prefill on the context value, re-running it on every value/onChange change would fight the user
  useEffect(() => {
    if (prefilledRef.current || !contextScriptHash) return;
    prefilledRef.current = true;
    if (value.scriptHashHex === '') onChange({ ...value, scriptHashHex: contextScriptHash });
    // The prefill is a one-shot on the context value, not a sync of the field.
  }, [contextScriptHash]);

  const byteLength = useMemo(() => ENCODER.encode(value.text).length, [value.text]);
  const overCap = byteLength > CONSTITUTION_DOCUMENT_MAX_BYTES;
  const hashInvalid = value.scriptHashHex.trim() !== '' && !SCRIPT_HASH_RE.test(value.scriptHashHex.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <PrevActionField
        context={prevContext}
        value={value.prev}
        onChange={prev => onChange({ ...value, prev })}
        disabled={disabled}
      />

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
          <label htmlFor="ga-constitution-text" style={labelStyle}>Constitution text</label>
          <span style={{ fontSize: '0.75rem', color: overCap ? 'var(--danger, #b3261e)' : 'var(--muted)', flexShrink: 0 }}>
            {formatBytes(byteLength)} / {formatBytes(CONSTITUTION_DOCUMENT_MAX_BYTES)}
          </span>
        </div>
        <span style={{ ...mutedStyle, display: 'block', margin: '0 0 0.375rem' }}>
          Markdown. The exact bytes you enter here are published to IPFS and anchored by their hash.
        </span>
        <textarea
          id="ga-constitution-text"
          value={value.text}
          onChange={e => onChange({ ...value, text: e.target.value })}
          rows={16}
          disabled={disabled}
          style={textAreaStyle}
          placeholder="# Constitution"
        />
        {overCap && (
          <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem', color: 'var(--danger, #b3261e)' }}>
            The document is over the {formatBytes(CONSTITUTION_DOCUMENT_MAX_BYTES)} limit and cannot be published.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="ga-guardrails-hash" style={labelStyle}>Guardrails script hash (optional)</label>
        <span style={{ ...mutedStyle, display: 'block', margin: '0 0 0.375rem' }}>
          56 hex characters. Leave empty to enact a constitution without a guardrails script.
        </span>
        <input
          id="ga-guardrails-hash"
          type="text"
          value={value.scriptHashHex}
          onChange={e => onChange({ ...value, scriptHashHex: e.target.value })}
          disabled={disabled}
          style={inputStyle}
          placeholder="Script hash in hex"
          spellCheck={false}
        />
        {hashInvalid && (
          <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem', color: 'var(--danger, #b3261e)' }}>
            A guardrails script hash is exactly 56 hex characters.
          </p>
        )}
        {contextScriptHash === null && (
          <p style={{ ...mutedStyle, margin: '0.375rem 0 0' }}>
            The constitution in force has no guardrails script hash on record here, so this field starts empty.
          </p>
        )}
      </div>
    </div>
  );
}
