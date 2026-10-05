// NewConstitution panel: the previous action, the constitution document
// itself, and the optional guardrails script hash. Presentational, with the
// two checks that can be made off chain (the byte cap and the hex shape) done
// inline, because nothing else about a constitution is checkable here.
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import PrevActionField from './PrevActionField.js';
import { CONSTITUTION_DOCUMENT_MAX_BYTES } from '@/lib/governance/infoActionLimits.js';
import { HEX_HASH_224_RE } from '@/lib/crypto/hex.js';
import type { ActionContextResponse } from '@/lib/governance/actionContextHandler.js';
import type { NewConstitutionPanelState } from '@/lib/governance/govActionFormState.js';
import type { NetworkConfig } from '@/lib/config/network.js';
import { inputStyle, labelStyle, mutedStyle } from '@/components/drepFormStyles.js';

export interface NewConstitutionPanelProps {
  context: ActionContextResponse;
  value: NewConstitutionPanelState;
  onChange: (value: NewConstitutionPanelState) => void;
  networkConfig: NetworkConfig;
  disabled?: boolean;
}

const textAreaStyle: CSSProperties = { ...inputStyle, lineHeight: '1.6', resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: '0.875rem' };

const ENCODER = new TextEncoder();

/** Human-readable size for the byte counter, kept to whole KiB above a kilobyte. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${Math.round(bytes / 1024)} KiB`;
}

export default function NewConstitutionPanel({ context, value, onChange, networkConfig, disabled = false }: NewConstitutionPanelProps) {
  const prevContext = context.prev ?? { lastEnacted: null, open: [] };
  const contextScriptHash = context.constitution?.scriptHash ?? null;

  // The default is derived, not written into the state by an effect: an edit
  // to the textarea in the same tick would otherwise be built on a state
  // without the hash and silently drop it. null means untouched, so the hash
  // in force shows, and an empty string means deliberately cleared.
  const scriptHashHex = value.scriptHashHex ?? contextScriptHash ?? '';

  const byteLength = useMemo(() => ENCODER.encode(value.text).length, [value.text]);
  const overCap = byteLength > CONSTITUTION_DOCUMENT_MAX_BYTES;
  const hashInvalid = scriptHashHex.trim() !== '' && !HEX_HASH_224_RE.test(scriptHashHex.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <PrevActionField
        context={prevContext}
        value={value.prev}
        onChange={prev => onChange({ ...value, prev })}
        networkConfig={networkConfig}
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
          value={scriptHashHex}
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
        {contextScriptHash !== null && (
          <p style={{ ...mutedStyle, margin: '0.375rem 0 0' }}>
            This is the guardrails script the constitution in force enforces. Clearing it proposes a constitution
            without a guardrails script.
          </p>
        )}
        {contextScriptHash === null && (
          <p style={{ ...mutedStyle, margin: '0.375rem 0 0' }}>
            No guardrails script hash could be read from the chain, leave empty to enact a constitution without one.
          </p>
        )}
      </div>
    </div>
  );
}
