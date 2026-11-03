// Founding wizard of a DRep group: the mode, founding alone or together with other DReps, the
// threshold of the management policy and optionally a separate admission policy, the profile, and
// a review of who must sign. Founding alone completes in one wallet step, founding together gives
// a signing link for the other founders.
import type { Anchor } from 'drep-groups';
import { useMemo, useRef, useState } from 'react';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { type GroupIntent, moreThanHalf, neededKeys } from '@/lib/groups/actions.js';
import { shortHash } from '@/lib/groups/view.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { Callout, DraftPanel, h2, muted, type Outcome, OutcomeNotice, stack, useActionRunner } from './actionFlow.js';
import { type CheckedDrep, DrepAdder, ProfileFields, profileDraftOf, profileError, storeProfile, ThresholdField, thresholdError } from './groupForms.js';

export interface GroupWizardProps {
  network: CardanoNetwork;
  /** The signed-in key DRep, always the first founder. */
  viewer: { drepId: string; keyHash: string };
  /** The server's wall clock slot when the page was rendered, the client clock may be off. */
  serverSlot: number;
}

type Step = 'mode' | 'founders' | 'threshold' | 'profile' | 'review';

const MODE_TEXT = {
  open: 'Open group: membership is self-declared, every DRep can join on their own.',
  permissioned: 'Permissioned group: membership is confirmed by the group, the group approves every request.',
} as const;

const radioRow = { display: 'inline-flex', gap: '0.375rem', alignItems: 'center' } as const;

export default function GroupWizard({ network, viewer, serverSlot }: GroupWizardProps) {
  const runner = useActionRunner(network);
  const renderedAt = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  const viewerKey = viewer.keyHash.toLowerCase();
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<'open' | 'permissioned'>('permissioned');
  const [together, setTogether] = useState(false);
  const [others, setOthers] = useState<CheckedDrep[]>([]);
  const [n, setN] = useState(1);
  const [separate, setSeparate] = useState(false);
  // Admission keys beyond the founders, the keys left unticked and the admission threshold.
  const [extra, setExtra] = useState<string[]>([]);
  const [unticked, setUnticked] = useState<string[]>([]);
  const [admissionN, setAdmissionN] = useState(1);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [profile, setProfile] = useState(profileDraftOf(null));
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const founders = useMemo(() => (together ? others : []), [together, others]);
  const founderKeys = useMemo(() => [viewerKey, ...founders.map((f) => f.keyHash)], [viewerKey, founders]);
  const admissionKeys = [...founderKeys, ...extra.filter((k) => !founderKeys.includes(k))];
  const admissionTicked = admissionKeys.filter((k) => !unticked.includes(k));
  const nameOf = (key: string): string =>
    key === viewerKey ? 'You' : (names.get(key) ?? shortHash(founders.find((f) => f.keyHash === key)?.drepId ?? key));
  const remember = (d: CheckedDrep) => {
    if (d.name) setNames((m) => new Map(m).set(d.keyHash, d.name as string));
  };

  const intent: GroupIntent | null = anchor
    ? {
        kind: 'group_create',
        mode,
        control: { keys: founderKeys, n },
        admission: mode === 'open' ? null : separate ? { keys: admissionTicked, n: admissionN } : 'same',
        founders: [viewer.drepId, ...founders.map((f) => f.drepId)],
        profile: anchor,
      }
    : null;

  const go = (s: Step) => {
    setMessage(null);
    setStep(s);
  };

  function toThreshold() {
    if (together && others.length === 0) {
      setMessage('Add at least one other founder, or found the group alone.');
      return;
    }
    setN(moreThanHalf(founderKeys.length));
    setAdmissionN(moreThanHalf(admissionTicked.length || 1));
    go('threshold');
  }

  const admissionProblem =
    !separate || mode === 'open'
      ? null
      : admissionTicked.length === 0
        ? 'Tick at least one admission key.'
        : thresholdError(admissionN, admissionTicked.length);
  const thresholdBlocked = thresholdError(n, founderKeys.length) !== null || admissionProblem !== null;

  async function toReview() {
    const problem = profileError(profile);
    if (problem) {
      setMessage(problem);
      return;
    }
    setMessage(null);
    setBusy(true);
    try {
      setAnchor(await storeProfile(profile));
      setStep('review');
    } catch (err) {
      setMessage(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function build() {
    if (!intent) return;
    const tipSlot = serverSlot + Math.floor((performance.now() - renderedAt.current) / 1000);
    const keys = neededKeys(intent, null, null);
    const o = await runner.run({ intent, state: null, memberScript: null, keys, signers: [], viewerKey, tipSlot });
    if (o) setOutcome(o);
  }

  const nav = (back: Step | null, onNext: () => void, disabled = false) => (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button type="button" className="btn btn-primary" disabled={disabled || busy} onClick={onNext}>
        Next
      </button>
      {back && (
        <button type="button" className="btn" disabled={busy} onClick={() => go(back)}>
          Back
        </button>
      )}
    </div>
  );

  if (outcome) {
    return (
      <div style={{ ...stack, maxWidth: '40rem' }}>
        <OutcomeNotice outcome={outcome} network={network} />
        {'submitted' in outcome && <p style={muted}>The group page appears once the chain confirms the founding.</p>}
      </div>
    );
  }

  const keys = intent ? neededKeys(intent, null, null) : null;
  const solo = keys !== null && keys.mandatory.length === 1 && keys.mandatory[0] === viewerKey;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '40rem' }}>
      {step === 'mode' && (
        <section aria-label="Mode" style={stack}>
          <h2 style={h2}>How do members join?</h2>
          {(['permissioned', 'open'] as const).map((m) => (
            <label key={m} style={radioRow}>
              <input type="radio" name="group-mode" checked={mode === m} onChange={() => setMode(m)} />
              {MODE_TEXT[m]}
            </label>
          ))}
          <p style={muted}>The mode is fixed once the group is founded.</p>
          {nav(null, () => go('founders'))}
        </section>
      )}

      {step === 'founders' && (
        <section aria-label="Founders" style={stack}>
          <h2 style={h2}>Who founds the group?</h2>
          <label style={radioRow}>
            <input type="radio" name="group-founding" checked={!together} onChange={() => setTogether(false)} />
            Found alone
          </label>
          <label style={radioRow}>
            <input type="radio" name="group-founding" checked={together} onChange={() => setTogether(true)} />
            Found together with other DReps
          </label>
          {together && (
            <>
              <p style={muted}>Every founder becomes a member and an admin, and signs the founding transaction.</p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.25rem' }}>
                <li>You</li>
                {others.map((f) => (
                  <li key={f.keyHash} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span>{nameOf(f.keyHash)}</span>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Remove ${nameOf(f.keyHash)}`}
                      onClick={() => setOthers((xs) => xs.filter((x) => x.keyHash !== f.keyHash))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <DrepAdder
                label="Add a founder by DRep id"
                listed={[viewerKey, ...others.map((f) => f.keyHash)]}
                onAdd={(d) => {
                  remember(d);
                  setOthers((xs) => [...xs, d]);
                }}
              />
            </>
          )}
          {message && <p role="alert" style={muted}>{message}</p>}
          {nav('mode', toThreshold)}
        </section>
      )}

      {step === 'threshold' && (
        <section aria-label="Threshold" style={stack}>
          <h2 style={h2}>How many admins must sign?</h2>
          <p style={muted}>The founders are the admins of the management policy, which changes the profile, the policies and dissolves the group.</p>
          <ThresholdField n={n} k={founderKeys.length} onChange={setN} />
          {mode === 'permissioned' && (
            <>
              <label style={{ ...radioRow, fontSize: '0.875rem' }}>
                <input type="checkbox" checked={separate} onChange={() => setSeparate((x) => !x)} />
                Use a separate admission policy for approving and removing members (advanced)
              </label>
              {separate && (
                <div style={stack}>
                  <p style={muted}>Admission keys that are not founders sign the founding transaction but do not become members.</p>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.25rem' }}>
                    {admissionKeys.map((k) => (
                      <li key={k}>
                        <label style={radioRow}>
                          <input
                            type="checkbox"
                            aria-label={nameOf(k)}
                            checked={!unticked.includes(k)}
                            onChange={() => setUnticked((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]))}
                          />
                          {nameOf(k)}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <DrepAdder
                    label="Add an admission key by DRep id"
                    listed={admissionKeys}
                    onAdd={(d) => {
                      remember(d);
                      setExtra((xs) => [...xs, d.keyHash]);
                    }}
                  />
                  {admissionTicked.length > 0 ? (
                    <ThresholdField label="Admission threshold" n={admissionN} k={admissionTicked.length} onChange={setAdmissionN} />
                  ) : (
                    <p style={muted}>Tick at least one admission key.</p>
                  )}
                </div>
              )}
            </>
          )}
          {nav('founders', () => go('profile'), thresholdBlocked)}
        </section>
      )}

      {step === 'profile' && (
        <section aria-label="Profile" style={stack}>
          <h2 style={h2}>Profile</h2>
          <ProfileFields value={profile} onChange={setProfile} disabled={busy} />
          {message && <p role="alert" style={muted}>{message}</p>}
          {nav('threshold', () => void toReview())}
        </section>
      )}

      {step === 'review' && intent && keys && intent.kind === 'group_create' && (
        <DraftPanel
          label="Found the group"
          keys={keys}
          signers={[]}
          onSigners={() => {}}
          satisfied
          nameOf={nameOf}
          viewerKey={viewerKey}
          runner={runner}
          onBuild={() => void build()}
          onBack={() => go('profile')}
        >
          <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'grid', gap: '0.25rem' }}>
            <li>{profile.name.trim()}</li>
            <li>{MODE_TEXT[intent.mode]}</li>
            <li>Founders: {intent.control.keys.map(nameOf).join(', ')}</li>
            <li>
              Management policy: {intent.control.n} of {intent.control.keys.length} must sign
            </li>
            {intent.admission === 'same' && <li>Admission: the same policy</li>}
            {intent.admission !== null && intent.admission !== 'same' && (
              <li>
                Admission: {intent.admission.n} of {intent.admission.keys.length} must sign ({intent.admission.keys.map(nameOf).join(', ')})
              </li>
            )}
          </ul>
          {keys.mandatory.length > 1 && <p style={muted}>Every founder signs the founding transaction, also when the threshold is lower.</p>}
          <p style={muted}>
            {solo ? 'You found the group alone and sign it in one wallet step.' : 'After you sign, share the signing link with everyone else who must sign.'}
          </p>
        </DraftPanel>
      )}
      {runner.error && <Callout kind="error">{runner.error}</Callout>}
    </div>
  );
}
