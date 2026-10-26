// React island: the proposer's governance actions on /home, each with its
// co-proposers and an invite control. Invite creation is client-only (the
// one-time invite URL is emitted exactly once by the server and must be shown
// here, not persisted anywhere). Remove and withdraw are fetch-then-reload: the
// server-rendered lists are the source of truth, so a full reload after either
// action is simpler and safer than reconciling client state.
//
// Client bundle: only client-safe imports here. The row types come from the
// server module as types only, which the compiler erases.
import { useState } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { CopyButton } from '@/components/CopyButton.tsx';
import { MAX_GRANTS_PER_ACTION } from '@/lib/auth/coProposerLimits.js';
import { formatEpochDate, readableType, shortGovActionId, statusBadge, TONE_COLORS } from '@/lib/governance/view.js';
import type { ProposerActionView } from '@/lib/db/proposerHome.js';

export type { ProposerActionView, PendingInviteView, CoProposerView } from '@/lib/db/proposerHome.js';

interface Props {
  actions: ProposerActionView[];
}

/** Row count from which the list gets a search box. */
const SEARCH_FROM = 10;

type InviteState =
  | { status: 'idle' }
  | { status: 'picking' }
  | { status: 'creating' }
  | { status: 'created'; url: string; expiresAt: number }
  | { status: 'error'; message: string };

/** Title, else readable type plus short id, the same fallback the list search matches on. */
function displayTitle(a: Pick<ProposerActionView, 'title' | 'type' | 'id'>): string {
  return a.title?.trim() || `${readableType(a.type)} ${shortGovActionId(a.id)}`;
}

function matches(a: ProposerActionView, query: string): boolean {
  if (!query) return true;
  return [displayTitle(a), a.id, a.proposalId ?? ''].some((s) => s.toLowerCase().includes(query));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function friendlyInviteError(error: string | undefined): string {
  const e = (error ?? '').toLowerCase();
  if (e.includes('limit reached')) return `This action already has ${MAX_GRANTS_PER_ACTION} co-proposers or open invites.`;
  if (e.includes('action finished')) return 'This action is finished, invites are closed.';
  if (e.includes('no thread yet')) return 'This action has no discussion thread yet.';
  if (e.includes('unknown team')) return 'That team name is no longer listed for this action. Reload and pick again.';
  if (e.includes('rate_limited')) return 'Too many attempts. Please wait a bit and try again.';
  if (e.includes('unauthorized') || e.includes('forbidden')) return 'Please sign in again.';
  return 'Could not create an invite. Please try again.';
}

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

/** One governance action: header, invite control, pending invites and active co-proposers. */
function ActionItem({ action }: { action: ProposerActionView }) {
  const [invite, setInvite] = useState<InviteState>({ status: 'idle' });
  const [team, setTeam] = useState('');
  // Bumped on a successful create so the slot count reflects it immediately,
  // without inventing a grantId the create response deliberately does not echo.
  const [justCreated, setJustCreated] = useState(0);
  const [busyGrantId, setBusyGrantId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const badge = statusBadge(action.status);
  const title = displayTitle(action);
  const slotsUsed = action.pending.length + action.active.length + justCreated;
  const atLimit = slotsUsed >= MAX_GRANTS_PER_ACTION;
  const creating = invite.status === 'creating';
  const blockedReason = !action.topicSlug
    ? 'No discussion thread yet. Invites open once the thread exists.'
    : atLimit
      ? `Limit of ${MAX_GRANTS_PER_ACTION} co-proposers reached. Remove one or withdraw an invite to add another.`
      : null;

  const counts = [
    action.active.length > 0 ? plural(action.active.length, 'co-proposer') : 'No co-proposers',
    ...(action.pending.length > 0 ? [`${plural(action.pending.length, 'invite')} pending`] : []),
  ].join(', ');

  async function createInvite(teamLabel: string) {
    setActionError(null);
    setInvite({ status: 'creating' });
    try {
      // "No team name" sends no teamLabel key at all.
      const body = teamLabel ? { govActionId: action.id, teamLabel } : { govActionId: action.id };
      const res = await fetchWithTimeout('/api/auth/co-proposer/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { inviteUrl?: string; expiresAt?: number; error?: string } | null;
      if (!res.ok || !data?.inviteUrl || !data.expiresAt) {
        setInvite({ status: 'error', message: friendlyInviteError(data?.error) });
        return;
      }
      setInvite({ status: 'created', url: `${window.location.origin}${data.inviteUrl}`, expiresAt: data.expiresAt });
      setJustCreated((n) => n + 1);
      setTeam('');
    } catch {
      setInvite({ status: 'error', message: 'Could not create an invite. Please try again.' });
    }
  }

  function startInvite() {
    // Without CIP-108 authors there is no team to pick, so one click creates the invite.
    if (action.authors.length === 0) void createInvite('');
    else setInvite({ status: 'picking' });
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
      setActionError('That did not work. Please try again.');
    } catch {
      setActionError('That did not work. Please try again.');
    } finally {
      setBusyGrantId(null);
    }
  }

  return (
    <li className="pa__item">
      <div className="pa__head">
        <div className="pa__headtext">
          <p className="pa__title">{action.topicSlug ? <a href={`/t/${action.topicSlug}/`}>{title}</a> : title}</p>
          <p className="pa__meta">
            <span className="pa__status" style={{ color: TONE_COLORS[badge.tone] }}>
              {badge.label}
            </span>
            <span className="pa__type">{readableType(action.type)}</span>
            <span>{counts}</span>
          </p>
        </div>
        {action.open && (
          <div className="pa__headactions">
            <button
              type="button"
              className="btn btn-secondary pa__btn"
              disabled={blockedReason !== null || creating || invite.status === 'picking'}
              onClick={startInvite}
            >
              {creating ? 'Creating invite...' : 'Invite co-proposer'}
            </button>
          </div>
        )}
      </div>

      {action.open && blockedReason && <p className="pa__note">{blockedReason}</p>}

      {invite.status === 'picking' && (
        <div className="pa__picker">
          <label className="pa__pickerlabel">
            Team name
            <select className="pa__select" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">No team name</option>
              {action.authors.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <p className="pa__pickerhint">Shown next to their posts in this thread. Names come from the action's authors.</p>
          <div className="pa__pickeractions">
            <button type="button" className="btn btn-primary pa__btn" onClick={() => void createInvite(team)}>
              Create invite
            </button>
            <button type="button" className="btn btn-ghost pa__btn" onClick={() => setInvite({ status: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {invite.status === 'created' && (
        <div className="callout callout--success pa__callout" role="status">
          {IconCheck}
          <div className="callout__body">
            <div className="pa__invite">
              <span className="pa__inviteurl">{invite.url}</span>
              <CopyButton value={invite.url} label="Copy invite link" />
            </div>
            <p className="pa__invitehint">
              Shown only once. Valid until {formatEpochDate(invite.expiresAt)}, single use.{' '}
              <a href="/help/proposers/#co-proposers">Share it over a private channel.</a>
            </p>
          </div>
        </div>
      )}

      {invite.status === 'error' && (
        <div className="callout callout--error pa__callout" role="alert">
          {IconError}
          <div className="callout__body">{invite.message}</div>
        </div>
      )}

      {actionError && (
        <p role="alert" className="pa__error">
          {actionError}
        </p>
      )}

      {(action.active.length > 0 || action.pending.length > 0) && (
        <ul className="pa__grants">
          {action.active.map((g) => (
            <li key={g.grantId} className="nset__row pa__grant">
              <div className="nset__rowtext">
                <p className="nset__rowtitle">{g.coName}</p>
                <p className="nset__rowmeta">
                  {[
                    g.teamLabel ? `Proposer team · ${g.teamLabel}` : null,
                    g.coStakeAddr,
                    g.since !== null ? `Since ${formatEpochDate(g.since)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <div className="nset__rowactions">
                <button
                  type="button"
                  className="btn btn-secondary pa__btn"
                  disabled={busyGrantId === g.grantId}
                  onClick={() => void handlePost('/api/auth/co-proposer/revoke', g.grantId)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
          {action.pending.map((g) => (
            <li key={g.grantId} className="nset__row pa__grant">
              <div className="nset__rowtext">
                <p className="nset__rowtitle">Invite pending</p>
                <p className="nset__rowmeta">
                  {[g.teamLabel ? `Proposer team · ${g.teamLabel}` : null, `Expires ${formatEpochDate(g.expiresAt)}`]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <div className="nset__rowactions">
                <button
                  type="button"
                  className="btn btn-secondary pa__btn"
                  disabled={busyGrantId === g.grantId}
                  onClick={() => void handlePost('/api/auth/co-proposer/withdraw', g.grantId)}
                >
                  Withdraw
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function ProposerActions({ actions }: Props) {
  const [query, setQuery] = useState('');
  const [showFinished, setShowFinished] = useState(false);

  const q = query.trim().toLowerCase();
  const openRows = actions.filter((a) => a.open && matches(a, q));
  const finishedRows = actions.filter((a) => !a.open && matches(a, q));

  if (actions.length === 0) {
    return <p className="pa__empty">Your governance actions show up here once DRepTalk has synced them.</p>;
  }

  return (
    <div className="pa">
      {actions.length >= SEARCH_FROM && (
        <input
          type="search"
          className="pa__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title or action id"
          aria-label="Search your governance actions"
        />
      )}

      {openRows.length > 0 && (
        <ul className="pa__list">
          {openRows.map((a) => (
            <ActionItem key={a.id} action={a} />
          ))}
        </ul>
      )}
      {q !== '' && openRows.length === 0 && finishedRows.length === 0 && (
        <p className="pa__empty">No governance action matches this search.</p>
      )}
      {q === '' && openRows.length === 0 && <p className="pa__empty">None of your governance actions is open right now.</p>}

      {finishedRows.length > 0 && (
        <div className="pa__finished">
          {/* While searching, matching finished rows show directly. Otherwise the
              finished group stays collapsed behind a toggle. */}
          {q === '' && (
            <button
              type="button"
              className="btn btn-ghost pa__btn"
              aria-expanded={showFinished}
              onClick={() => setShowFinished((v) => !v)}
            >
              {showFinished ? 'Hide finished actions' : `Show finished actions (${finishedRows.length})`}
            </button>
          )}
          {(showFinished || q !== '') && (
            <ul className="pa__list">
              {finishedRows.map((a) => (
                <ActionItem key={a.id} action={a} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
