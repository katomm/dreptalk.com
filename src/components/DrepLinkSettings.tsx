// "Your drep.link" section on /settings/profile/: shows the DRep's short link and
// lets it pick another one. Changes are rare by design (90 days between changes,
// the old link keeps redirecting for 180 days), so a change takes a confirm step.
import { useState } from 'react';
import { CopyButton } from './CopyButton';
import { inputStyle, labelStyle } from './drepFormStyles';
import { DREP_LINK_HOST, DREP_LINK_ORIGIN, normalizeHandleInput, validateHandle } from '@/lib/drepLink/handle';
import { claimErrorMessage, formatLinkDate } from '@/lib/drepLink/messages';
import { nextNewHandleAt } from '@/lib/drepLink/claim';

interface Props {
  current: string | null;
  previous: { handle: string; until: number } | null;
  drepId: string;
  hasName: boolean;
  cooldownUntil: number | null;
}

const mutedStyle = { margin: 0, fontSize: '0.875rem', color: 'var(--muted)' } as const;

export default function DrepLinkSettings({ current: initialCurrent, previous: initialPrevious, drepId, hasName, cooldownUntil: initialCooldown }: Props) {
  const [current, setCurrent] = useState(initialCurrent);
  const [previous, setPrevious] = useState(initialPrevious);
  const [cooldownUntil, setCooldownUntil] = useState(initialCooldown);
  const [input, setInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const now = Math.floor(Date.now() / 1000);
  const onCooldown = cooldownUntil !== null && cooldownUntil > now;
  // A new name also waits for the previous link to expire. Switching back to it
  // is possible as soon as the cooldown is over.
  const newNameAt = nextNewHandleAt(cooldownUntil, previous?.until ?? null);
  const onlyTakeBack = !onCooldown && previous !== null && newNameAt !== null && newNameAt > now;
  const candidate = normalizeHandleInput(input);
  const check = candidate ? validateHandle(candidate, drepId) : null;
  const inlineError = check && !check.ok ? claimErrorMessage(check.reason, null) : null;
  const shownSlug = current ?? drepId;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/drep/handle', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: candidate, expectedCurrent: current }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        handle?: string;
        previous?: { handle: string; until: number } | null;
        cooldownUntil?: number;
        error?: string;
        until?: number | null;
      };
      if (res.ok && body.ok && body.handle) {
        // Show what the server stored. The cooldown hides the form from here on.
        setCurrent(body.handle);
        setPrevious(body.previous ?? null);
        setCooldownUntil(body.cooldownUntil ?? null);
        setSaved(true);
      } else {
        setError(claimErrorMessage(body.error ?? '', body.until ?? null));
        setConfirming(false);
      }
    } catch {
      setError(claimErrorMessage('', null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="drep-link" aria-labelledby="drep-link-heading" style={{ maxWidth: '32rem', margin: '0 0 2rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <h2 id="drep-link-heading" style={{ margin: 0, fontSize: '1.125rem' }}>Your drep.link</h2>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <a href={`${DREP_LINK_ORIGIN}/${shownSlug}`} style={{ fontWeight: 600, wordBreak: 'break-all' }}>
          {DREP_LINK_HOST}/{shownSlug}
        </a>
        <CopyButton value={`${DREP_LINK_ORIGIN}/${shownSlug}`} label="Copy drep.link" />
      </div>

      {!current && (
        <p style={mutedStyle}>
          {hasName
            ? 'You have no short name yet. Pick one below.'
            : 'Add a name to your DRep metadata to get a drep.link, or pick one below.'}
        </p>
      )}
      {previous && (
        <p style={mutedStyle}>
          Your previous link {DREP_LINK_HOST}/{previous.handle} keeps working until {formatLinkDate(previous.until)}.
        </p>
      )}
      {saved && (
        <div className="callout callout--success" role="status">
          <div className="callout__body">Saved. It can take up to five minutes until the new link works everywhere.</div>
        </div>
      )}

      {onCooldown ? (
        <p style={mutedStyle}>
          {previous
            ? `You can pick a new drep.link on ${formatLinkDate(newNameAt as number)}. From ${formatLinkDate(cooldownUntil as number)} on, you can switch back to ${DREP_LINK_HOST}/${previous.handle}.`
            : `You can change your drep.link again on ${formatLinkDate(cooldownUntil as number)}.`}
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!candidate || inlineError) return;
            if (!confirming) setConfirming(true);
            else void submit();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
        >
          {onlyTakeBack && previous && (
            <p style={mutedStyle}>
              Until {formatLinkDate(previous.until)} you can only switch back to {DREP_LINK_HOST}/{previous.handle}.
            </p>
          )}
          <label htmlFor="drep-link-input" style={labelStyle}>{current ? 'Change your link' : 'Pick your link'}</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{DREP_LINK_HOST}/</span>
            <input
              id="drep-link-input"
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value.toLowerCase());
                setConfirming(false);
                setError(null);
              }}
              placeholder={current ?? 'yourname'}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={64}
              disabled={busy}
              aria-invalid={inlineError ? true : undefined}
              aria-describedby="drep-link-help"
              style={inputStyle}
            />
          </div>
          <p id="drep-link-help" style={{ ...mutedStyle, color: inlineError ? 'var(--danger)' : 'var(--muted)' }}>
            {inlineError ?? 'Lowercase letters, digits and single hyphens, 3 to 40 characters.'}
          </p>

          {confirming && (
            <div className="callout callout--warning" role="note">
              <div className="callout__body">
                Your old link keeps working for 180 days, then it becomes free for others. You can pick a new drep.link again once it has expired, and switch back to it after 90 days.
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={busy || !candidate || inlineError !== null}>
              {busy ? 'Saving...' : confirming ? 'Change link' : 'Continue'}
            </button>
            {confirming && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {error && (
        <div className="callout callout--error" role="alert">
          <div className="callout__body">{error}</div>
        </div>
      )}
    </section>
  );
}
