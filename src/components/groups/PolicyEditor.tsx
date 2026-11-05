// What the admins of a DRep group change through the control policy: the profile, the admins and
// the threshold of the management policy, and dissolving the group. Each change becomes an intent
// that the group page builds and signs like every other group action. All of them hold the
// group's single management slot, so the editor waits while another one is open.
import { useState } from 'react';
import { carryThreshold, type GroupIntent, sameSet, uniq } from '@/lib/groups/actions.js';
import type { GroupProfileInput } from '@/lib/groups/profileDocs.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { SLOT_HELD } from './actionFlow.js';
import SegmentedControl from '@/components/SegmentedControl.js';
import { DrepAdder, type ProfileDraft, ProfileFields, profileDraftOf, profileError, storeProfile, ThresholdField, thresholdError } from './groupForms.js';
import { Callout, choice, h3, muted, part, rows, stack } from './groupUi.js';

/** The policy proposal a form edits: the keys offered, those ticked and the threshold. */
export interface Proposal {
  keys: string[];
  ticked: string[];
  n: number;
  sameAdmission: boolean;
}

export const proposalOf = (p: { keys: string[]; n: number; sameAdmission: boolean }): Proposal => ({ keys: p.keys, ticked: p.keys, n: p.n, sameAdmission: p.sameAdmission });

/** The update of the management policy a proposal stands for, with the given join approvals. */
export const updateIntent = (group: string, p: Proposal, approvals: string[]): GroupIntent => ({
  kind: 'group_update',
  group,
  approvals,
  control: { keys: p.ticked, n: p.n },
  ...(p.sameAdmission ? { admission: 'same' as const } : {}),
});

export const DISSOLVE_WARNING = "This cannot be undone. Members' delegations do not change.";

/** The keys of a management policy to tick, its threshold and who has to sign for being newly listed. */
export function PolicyFields({
  proposal,
  onChange,
  current,
  listed,
  nameOf,
}: {
  proposal: Proposal;
  onChange: (p: Proposal) => void;
  current: { n: number; k: number };
  listed: Set<string>;
  nameOf: (k: string) => string;
}) {
  const k = proposal.ticked.length;
  const toggle = (key: string) => {
    const ticked = proposal.ticked.includes(key) ? proposal.ticked.filter((x) => x !== key) : uniq([...proposal.ticked, key]);
    const n = ticked.length === 0 ? 1 : Math.min(ticked.length, Math.max(1, carryThreshold(ticked.length, current.n, current.k)));
    onChange({ ...proposal, ticked, n });
  };
  const newlyListed = proposal.ticked.filter((x) => !listed.has(x));
  return (
    <div style={stack}>
      <ul style={rows}>
        {proposal.keys.map((key) => (
          <li key={key}>
            <label style={choice}>
              <input type="checkbox" checked={proposal.ticked.includes(key)} onChange={() => toggle(key)} aria-label={nameOf(key)} />
              {nameOf(key)}
            </label>
          </li>
        ))}
      </ul>
      {k > 0 && <ThresholdField n={proposal.n} k={k} onChange={(n) => onChange({ ...proposal, n })} />}
      {newlyListed.length > 0 && <p style={muted}>Each newly listed admin has to sign the update: {newlyListed.map(nameOf).join(', ')}.</p>}
    </div>
  );
}

export interface PolicyEditorProps {
  groupId: string;
  /** Threshold of the current control policy. */
  current: { n: number; k: number };
  controlKeys: string[];
  /** The admission policy is the control policy and follows it. */
  sameAdmission: boolean;
  /** Every key of the current policies, a key outside them is newly listed. */
  listed: Set<string>;
  memberKeys: string[];
  nameOf: (key: string) => string;
  profile: GroupProfileInput | null;
  /** A proposal to start the policy change with, for example the members after a drift. */
  initial: Proposal | null;
  slotHeld: boolean;
  canDissolve: boolean;
  /**
   * `names` holds the names of admins added by DRep id, by key hash. A profile change gives the
   * profile before and after, for the description of the draft.
   */
  onContinue: (intent: GroupIntent, label: string, names: Map<string, string>, profile?: { before: ProfileDraft; after: ProfileDraft }) => void;
  onClose: () => void;
}

type Task = 'profile' | 'policy' | 'dissolve';

export default function PolicyEditor(props: PolicyEditorProps) {
  const { groupId, current, controlKeys, sameAdmission, listed, memberKeys, slotHeld, canDissolve, onContinue, onClose } = props;
  const [task, setTask] = useState<Task>(props.initial ? 'policy' : 'profile');
  const [proposal, setProposal] = useState<Proposal>(
    props.initial ?? { keys: uniq([...controlKeys, ...memberKeys]), ticked: uniq(controlKeys), n: current.n, sameAdmission },
  );
  const [added, setAdded] = useState<Map<string, string>>(new Map());
  const [profile, setProfile] = useState(profileDraftOf(props.profile));
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (key: string) => added.get(key) ?? props.nameOf(key);

  // The threshold field shows its own message, the other problems are shown below the form.
  const otherProblem =
    proposal.ticked.length === 0
      ? 'Tick at least one admin.'
      : sameSet(proposal.ticked, controlKeys) && proposal.n === current.n
        ? 'This is the current policy.'
        : null;
  const policyProblem = (proposal.ticked.length > 0 ? thresholdError(proposal.n, proposal.ticked.length) : null) ?? otherProblem;

  async function continueProfile() {
    const problem = profileError(profile);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const anchor = await storeProfile(profile);
      onContinue({ kind: 'group_update', group: groupId, approvals: [], profile: anchor }, 'Change the profile', added, {
        before: profileDraftOf(props.profile),
        after: profile,
      });
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<[Task, string]> = [
    ['profile', 'Edit the profile'],
    ['policy', 'Change admins or threshold'],
    ...(canDissolve ? ([['dissolve', 'Dissolve the group']] as Array<[Task, string]>) : []),
  ];

  return (
    <section aria-label="Manage the group" style={part}>
      <h3 style={h3}>Manage the group</h3>
      {slotHeld ? (
        <p style={muted}>{SLOT_HELD}</p>
      ) : (
        <>
          <SegmentedControl
            ariaLabel="What to change"
            value={task}
            onChange={(t) => {
              setError(null);
              setTask(t);
            }}
            wrap
            minButtonInlineSize="11rem"
            options={tabs.map(([value, label]) => ({ value, label }))}
          />

          {task === 'profile' && (
            <div style={stack}>
              <ProfileFields value={profile} onChange={setProfile} disabled={busy} />
              <div>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void continueProfile()}>
                  Review and sign
                </button>
              </div>
            </div>
          )}

          {task === 'policy' && (
            <div style={stack}>
              <h4 style={h3}>Update the management policy</h4>
              <p style={muted}>Tick the admins of the new policy and how many of them must sign.</p>
              <PolicyFields proposal={proposal} onChange={setProposal} current={current} listed={listed} nameOf={nameOf} />
              <DrepAdder
                label="Add an admin by DRep id"
                listed={proposal.keys}
                onAdd={(d) => {
                  if (d.name) setAdded((m) => new Map(m).set(d.keyHash, d.name as string));
                  const ticked = uniq([...proposal.ticked, d.keyHash]);
                  setProposal({ ...proposal, keys: [...proposal.keys, d.keyHash], ticked, n: Math.max(1, carryThreshold(ticked.length, current.n, current.k)) });
                }}
              />
              {sameAdmission && <p style={muted}>Admission follows the management policy.</p>}
              {otherProblem && <p style={muted}>{otherProblem}</p>}
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={policyProblem !== null}
                  onClick={() => onContinue(updateIntent(groupId, proposal, []), 'Update the management policy', added)}
                >
                  Review and sign
                </button>
              </div>
            </div>
          )}

          {task === 'dissolve' && (
            <div style={stack}>
              <p style={{ margin: 0 }}>{DISSOLVE_WARNING}</p>
              <label style={choice}>
                <input type="checkbox" checked={confirmDissolve} onChange={() => setConfirmDissolve((x) => !x)} />
                Yes, dissolve this group
              </label>
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!confirmDissolve}
                  onClick={() => onContinue({ kind: 'group_dissolve', group: groupId }, 'Dissolve the group', added)}
                >
                  Review and sign
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <Callout kind="error">{error}</Callout>}
      <div>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
