// Form parts of the founding wizard and the policy editor: adding a founder or an admin by DRep
// id, which is checked to be a registered key DRep, the profile fields, and storing a profile
// document whose url and hash become the group's anchor.
import type { Anchor } from 'drep-groups';
import { useState } from 'react';
import DrepImageUpload from '@/components/DrepImageUpload.js';
import { credentialForDrepId } from '@/lib/groups/ids.js';
import type { GroupProfileInput } from '@/lib/groups/profileDocs.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { errorOf, muted, post, stack } from './groupUi.js';

export interface CheckedDrep {
  drepId: string;
  keyHash: string;
  name: string | null;
}

export const SCRIPT_DREP = 'Script DReps cannot be founders or admins. Each founder and admin signs with their own DRep key.';
export const NOT_REGISTERED = 'This DRep is not registered. Only registered DReps can be founders or admins.';

/** Whether a DRep id may be a founder or an admin, with its key hash and name, or why not. */
export async function checkDrep(raw: string): Promise<{ ok: true; drep: CheckedDrep } | { ok: false; message: string }> {
  const drepId = raw.trim().toLowerCase();
  const cred = credentialForDrepId(drepId);
  if (!cred) return { ok: false, message: 'This is not a valid DRep id.' };
  if (cred.kind === 'script') return { ok: false, message: SCRIPT_DREP };
  try {
    const res = await fetchWithTimeout(`/api/groups/check-drep?id=${encodeURIComponent(drepId)}`);
    if (!res.ok) return { ok: false, message: await errorOf(res, 'Could not check this DRep.') };
    const body = (await res.json()) as { registered: boolean; script: boolean; keyHash: string | null; name: string | null };
    if (body.script) return { ok: false, message: SCRIPT_DREP };
    if (!body.registered || !body.keyHash) return { ok: false, message: NOT_REGISTERED };
    return { ok: true, drep: { drepId, keyHash: body.keyHash, name: body.name } };
  } catch {
    return { ok: false, message: 'Could not check this DRep.' };
  }
}

/** A DRep id field with an Add button. Ids already listed are refused, the others are checked. */
export function DrepAdder({ label, listed, onAdd }: { label: string; listed: string[]; onAdd: (d: CheckedDrep) => void }) {
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function add() {
    setMessage(null);
    const cred = credentialForDrepId(value.trim().toLowerCase());
    if (cred && listed.includes(cred.hash.toLowerCase())) {
      setMessage('This DRep is already listed.');
      return;
    }
    setBusy(true);
    const checked = await checkDrep(value);
    setBusy(false);
    if (!checked.ok) {
      setMessage(checked.message);
      return;
    }
    onAdd(checked.drep);
    setValue('');
  }
  return (
    <div style={stack}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          aria-label={label}
          placeholder="drep1..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: '1 1 18rem', minWidth: 0 }}
        />
        <button type="button" className="btn" disabled={busy || value.trim() === ''} onClick={() => void add()}>
          Add
        </button>
      </div>
      {message && (
        <p role="alert" style={muted}>
          {message}
        </p>
      )}
    </div>
  );
}

/** A threshold field for n of k, with the share it stands for and a plain message when it is off. */
export function ThresholdField({ n, k, onChange, label = 'Threshold' }: { n: number; k: number; onChange: (n: number) => void; label?: string }) {
  return (
    <div style={stack}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center', fontSize: '0.875rem' }}>
          {label}
          <input type="number" min={1} max={k} value={Number.isNaN(n) ? '' : n} onChange={(e) => onChange(Number.parseInt(e.target.value, 10))} style={{ width: '4rem' }} />
        </label>
        {thresholdError(n, k) === null && (
          <span style={{ fontSize: '0.875rem' }}>
            {n} of {k} must sign ({Math.round((100 * n) / k)}%)
          </span>
        )}
        <button type="button" className="btn" onClick={() => onChange(Math.floor(k / 2) + 1)}>
          More than half
        </button>
      </div>
      {thresholdError(n, k) && (
        <p role="alert" style={muted}>
          {thresholdError(n, k)}
        </p>
      )}
    </div>
  );
}

/** Why a threshold n of k cannot be used, null when it can. */
export function thresholdError(n: number, k: number): string | null {
  if (!Number.isInteger(n) || n < 1) return 'The threshold must be at least 1.';
  if (n > k) return `The threshold cannot be higher than the number of keys (${k}).`;
  return null;
}

export interface ProfileDraft {
  name: string;
  description: string;
  website: string;
  charter: string;
  image: string;
}

export const profileDraftOf = (p: GroupProfileInput | null | undefined): ProfileDraft => ({
  name: p?.name ?? '',
  description: p?.description ?? '',
  website: p?.website ?? '',
  charter: p?.charter ?? '',
  image: p?.image ?? '',
});

const webUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/** Why the profile cannot be stored, null when it can. */
export function profileError(p: ProfileDraft): string | null {
  if (p.name.trim() === '') return 'Give the group a name.';
  if (p.description.trim() === '') return 'Add a description.';
  if (p.image.trim() === '') return 'Add an image.';
  if (p.website.trim() !== '' && !webUrl(p.website.trim())) return 'The website must be a web address starting with https:// or http://.';
  if (p.charter.trim() !== '' && !webUrl(p.charter.trim())) return 'The charter must be a web address starting with https:// or http://.';
  return null;
}

/** Stores the profile document and returns its anchor. */
export async function storeProfile(p: ProfileDraft): Promise<Anchor> {
  const body: Record<string, string> = { name: p.name.trim() };
  for (const key of ['description', 'website', 'charter', 'image'] as const) if (p[key].trim() !== '') body[key] = p[key].trim();
  const res = await post('/api/groups/profile', body);
  if (!res.ok) throw new Error(await errorOf(res, 'Could not store the profile.'));
  const { url, hash } = (await res.json()) as { url: string; hash: string };
  return { url, dataHash: hash };
}

export function ProfileFields({ value, onChange, disabled }: { value: ProfileDraft; onChange: (p: ProfileDraft) => void; disabled?: boolean }) {
  const field = (key: 'name' | 'website' | 'charter', label: string, placeholder?: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.875rem' }}>
      {label}
      <input type="text" value={value[key]} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange({ ...value, [key]: e.target.value })} />
    </label>
  );
  return (
    <div style={stack}>
      {field('name', 'Name')}
      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.875rem' }}>
        Description
        <textarea rows={4} value={value.description} disabled={disabled} onChange={(e) => onChange({ ...value, description: e.target.value })} />
      </label>
      {field('website', 'Website', 'https://')}
      {field('charter', 'Charter', 'https://')}
      <div style={{ fontSize: '0.875rem' }}>
        Image
        <DrepImageUpload
          value={value.image ? { url: value.image } : null}
          onChange={(img) => onChange({ ...value, image: img?.url ?? '' })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
