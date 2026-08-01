// React island: the co-proposer management panel on /settings/co-proposers.
// Invite creation is client-only (the one-time invite URL is emitted exactly
// once by the server and must be shown here, not persisted anywhere).
// Revoke/withdraw are simple fetch-then-reload actions: the server-rendered
// pending/active lists (via getGrantsForProposer) are the source of truth, so
// a full reload after either action is simpler and safer than reconciling
// client state with what actually happened server-side.
import { useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { CopyButton } from '@/components/CopyButton.tsx';

// ---- Types ------------------------------------------------------------------

export interface PendingGrantView {
  grantId: string;
  createdAt: number;
  expiresAt: number;
}

export interface ActiveGrantView {
  grantId: string;
  coName: string;
  coStakeAddr: string | null;
  since: number | null;
}

interface Props {
  initialPending: PendingGrantView[];
  initialActive: ActiveGrantView[];
  maxSlots: number;
}

type InviteState =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'created'; url: string; expiresAt: number }
  | { status: 'error'; message: string };

// ---- Error mapping ------------------------------------------------------------

function friendlyInviteError(error: string | undefined): string {
  const e = (error ?? '').toLowerCase();
  if (e.includes('limit reached')) return "You've reached the co-proposer limit. Revoke or withdraw one to invite another.";
  if (e.includes('rate_limited')) return 'Too many attempts. Please wait a bit and try again.';
  if (e.includes('unauthorized') || e.includes('forbidden')) return 'Please sign in again.';
  return 'Could not create an invite. Please try again.';
}

// ---- Icons ----------------------------------------------------------------

const IconCheck = (
  <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const IconError = (
  <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

// ---- Main island ------------------------------------------------------------

export default function CoProposerInvite({ initialPending, initialActive, maxSlots }: Props) {
  const [inviteState, setInviteState] = useState<InviteState>({ status: 'idle' });
  // Bumped on a successful create so the slot count reflects it immediately,
  // without inventing a fake grantId for a row we cannot yet withdraw (the
  // create response deliberately does not echo the grantId back).
  const [justCreatedCount, setJustCreatedCount] = useState(0);
  const [busyGrantId, setBusyGrantId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const slotsUsed = initialPending.length + initialActive.length + justCreatedCount;
  const atLimit = slotsUsed >= maxSlots;
  const creating = inviteState.status === 'creating';

  async function handleInvite() {
    setActionError(null);
    setInviteState({ status: 'creating' });
    try {
      const res = await fetchWithTimeout('/api/auth/co-proposer/invite', { method: 'POST' });
      const data = (await res.json().catch(() => null)) as { inviteUrl?: string; expiresAt?: number; error?: string } | null;
      if (!res.ok || !data?.inviteUrl || !data.expiresAt) {
        setInviteState({ status: 'error', message: friendlyInviteError(data?.error) });
        return;
      }
      const url = `${window.location.origin}${data.inviteUrl}`;
      setInviteState({ status: 'created', url, expiresAt: data.expiresAt });
      setJustCreatedCount((n) => n + 1);
    } catch {
      setInviteState({ status: 'error', message: 'Could not create an invite. Please try again.' });
    }
  }

  async function handlePost(path: string, grantId: string) {
    setActionError(null);
    setBusyGrantId(grantId);
    try {
      const res = await fetchWithTimeout(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grantId }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      setActionError('That action failed. Please try again.');
    } catch {
      setActionError('That action failed. Please try again.');
    } finally {
      setBusyGrantId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '40rem' }}>
      <div>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem', color: 'var(--muted)' }}>
          {slotsUsed} of {maxSlots} slots used
        </p>
        <button type="button" className="btn btn-primary" disabled={atLimit || creating} onClick={() => void handleInvite()}>
          {creating ? 'Creating invite...' : 'Invite co-proposer'}
        </button>
        {atLimit && (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
            You have reached the limit of {maxSlots} co-proposers. Revoke or withdraw one to invite another.
          </p>
        )}
      </div>

      {inviteState.status === 'created' && (
        <div className="callout callout--success" role="status">
          {IconCheck}
          <div className="callout__body">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8125rem', wordBreak: 'break-all' }}>
                {inviteState.url}
              </span>
              <CopyButton value={inviteState.url} label="Copy invite link" />
            </div>
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem' }}>
              Valid 7 days, single use.{' '}
              <strong>
                <a href="/help/proposers/#co-proposers">Share it over a private channel.</a>
              </strong>
            </p>
          </div>
        </div>
      )}

      {inviteState.status === 'error' && (
        <div className="callout callout--error" role="alert">
          {IconError}
          <div className="callout__body">{inviteState.message}</div>
        </div>
      )}

      {actionError && (
        <p role="alert" style={{ margin: 0, color: 'var(--danger)', fontSize: '0.875rem' }}>
          {actionError}
        </p>
      )}

      {initialPending.length > 0 && (
        <section>
          <h3 style={{ margin: '0 0 0.6rem', fontSize: '1rem' }}>Pending invites</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {initialPending.map((g) => (
              <div key={g.grantId} className="nset__row">
                <div className="nset__rowtext">
                  <p className="nset__rowtitle">Invited {new Date(g.createdAt * 1000).toLocaleDateString()}</p>
                  <p className="nset__rowmeta">Expires {new Date(g.expiresAt * 1000).toLocaleDateString()}</p>
                </div>
                <div className="nset__rowactions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busyGrantId === g.grantId}
                    onClick={() => void handlePost('/api/auth/co-proposer/withdraw', g.grantId)}
                    style={{ padding: '0.3rem 0.75rem', fontSize: '0.8125rem' }}
                  >
                    Withdraw
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {initialActive.length > 0 && (
        <section>
          <h3 style={{ margin: '0 0 0.6rem', fontSize: '1rem' }}>Active co-proposers</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {initialActive.map((g) => (
              <div key={g.grantId} className="nset__row">
                <div className="nset__rowtext">
                  <p className="nset__rowtitle">{g.coName}</p>
                  <p className="nset__rowmeta">
                    {g.coStakeAddr && (
                      <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{g.coStakeAddr}</span>
                    )}
                    {g.since !== null && <>{g.coStakeAddr ? ' · ' : ''}Since {new Date(g.since * 1000).toLocaleDateString()}</>}
                  </p>
                </div>
                <div className="nset__rowactions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busyGrantId === g.grantId}
                    onClick={() => void handlePost('/api/auth/co-proposer/revoke', g.grantId)}
                    style={{ padding: '0.3rem 0.75rem', fontSize: '0.8125rem' }}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
