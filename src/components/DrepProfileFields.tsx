// Shared, controlled field block for both DRep flows (registration + settings).
// Simple fields (name, image, bio, links) are always visible; the advanced
// CIP-119 fields live behind a collapsible so the common case stays simple.
import { useState } from 'react';
import DrepImageUpload, { type HostedImage } from '@/components/DrepImageUpload.js';
import DrepLinksEditor, { type ProfileLink } from '@/components/DrepLinksEditor.js';
import DrepProfilePreview from '@/components/DrepProfilePreview.js';
import { inputStyle, labelStyle } from '@/components/drepFormStyles.js';

export interface DrepProfileValue {
  name: string;
  bio: string;
  links: ProfileLink[];
  image: HostedImage | null;
  motivations: string;
  qualifications: string;
  paymentAddress: string;
  doNotList: boolean;
}

/**
 * Maps the editor's link rows to the wire shape the metadata endpoint expects:
 * trimmed label and uri, dropping rows with an empty uri. Shared by both flows
 * (registration + settings) so they cannot drift.
 */
export function profileLinksToWire(links: ProfileLink[]): { uri: string; label: string }[] {
  return links.filter((l) => l.uri.trim()).map((l) => ({ uri: l.uri.trim(), label: l.label.trim() }));
}

interface DrepProfileFieldsProps {
  value: DrepProfileValue;
  onChange: (next: DrepProfileValue) => void;
  disabled?: boolean;
  idPrefix: string;
  /** Identicon seed for the preview (the DRep id), matching the public profile. */
  seed: string;
}

const NAME_MAX = 80;
const BIO_MAX = 1000;
const TEXT_MAX = 1000;

export default function DrepProfileFields({ value, onChange, disabled, idPrefix, seed }: DrepProfileFieldsProps) {
  const [showAdvanced, setShowAdvanced] = useState(
    value.motivations !== '' || value.qualifications !== '' || value.paymentAddress !== '' || value.doNotList,
  );
  const set = <K extends keyof DrepProfileValue>(k: K, v: DrepProfileValue[K]) => onChange({ ...value, [k]: v });

  const textAreaStyle = { ...inputStyle, lineHeight: '1.6', resize: 'vertical' as const, fontFamily: 'inherit' };

  return (
    <div className="drep-profile-edit">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <label htmlFor={`${idPrefix}-name`} style={labelStyle}>Name</label>
        <input id={`${idPrefix}-name`} type="text" value={value.name} onChange={(e) => set('name', e.target.value)}
          placeholder="Your DRep name" maxLength={NAME_MAX} required disabled={disabled} style={inputStyle} />
      </div>

      <div>
        <span style={labelStyle}>Profile image (optional)</span>
        <DrepImageUpload value={value.image} onChange={(img) => set('image', img)} disabled={disabled} />
      </div>

      <div>
        <label htmlFor={`${idPrefix}-bio`} style={labelStyle}>Bio</label>
        <textarea id={`${idPrefix}-bio`} value={value.bio} onChange={(e) => set('bio', e.target.value)}
          placeholder="Tell delegators what you stand for (plain text)." maxLength={BIO_MAX} rows={6} disabled={disabled} style={textAreaStyle} />
      </div>

      <div>
        <span style={labelStyle}>Links</span>
        <DrepLinksEditor value={value.links} onChange={(links) => set('links', links)} disabled={disabled} />
      </div>

      <div>
        <button type="button" onClick={() => setShowAdvanced((s) => !s)}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }}>
          {showAdvanced ? 'Hide advanced fields' : 'Show advanced fields'}
        </button>
      </div>

      {showAdvanced && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', borderLeft: '2px solid var(--border)', paddingLeft: '0.875rem' }}>
          <div>
            <label htmlFor={`${idPrefix}-motivations`} style={labelStyle}>Motivations</label>
            <textarea id={`${idPrefix}-motivations`} value={value.motivations} onChange={(e) => set('motivations', e.target.value)}
              placeholder="Why you serve as a DRep." maxLength={TEXT_MAX} rows={4} disabled={disabled} style={textAreaStyle} />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-qualifications`} style={labelStyle}>Qualifications</label>
            <textarea id={`${idPrefix}-qualifications`} value={value.qualifications} onChange={(e) => set('qualifications', e.target.value)}
              placeholder="Your relevant background." maxLength={TEXT_MAX} rows={4} disabled={disabled} style={textAreaStyle} />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-payment`} style={labelStyle}>Payment address</label>
            <input id={`${idPrefix}-payment`} type="text" value={value.paymentAddress} onChange={(e) => set('paymentAddress', e.target.value)}
              placeholder="addr1... or addr_test1..." maxLength={150} disabled={disabled} style={inputStyle} />
          </div>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.875rem' }}>
            <input type="checkbox" checked={value.doNotList} onChange={(e) => set('doNotList', e.target.checked)} disabled={disabled} style={{ marginTop: '0.15rem' }} />
            <span>Set the CIP-119 "do not list" flag (kept in your on-chain metadata; DRepTalk still shows you).</span>
          </label>
        </div>
      )}
      </div>

      <aside className="drep-profile-edit__preview">
        <DrepProfilePreview value={value} seed={seed} />
      </aside>
    </div>
  );
}
