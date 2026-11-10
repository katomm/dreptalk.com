// The signed-in part of a DRep group page, loaded only for a session: joining, requesting to join
// and leaving, the request queue of the admins with approve or remove and the offer to update the
// management policy in the same transaction, removing active members, the notice when the policy
// keys drifted from the members, and the policy editor with the resign of an admin. Keys that
// resigned from a role stay in its script but count as admins of that role nowhere. Every action is built in the browser and
// either completes in one wallet step or gives a link.
import { type Credential, evaluateNativeScript, type NativeScript } from 'drep-groups';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardanoNetwork } from '@/lib/config/network.js';
import {
  changesOfIntent,
  type GroupIntent,
  type GroupState,
  IntentError,
  mayInitiate,
  neededKeys,
  proposeDrift,
  proposeUpdate,
  resignFreezes,
  sameSet,
  signerSetSatisfies,
  thresholdOf,
  uniq,
} from '@/lib/groups/actions.js';
import { libraryScript, scriptFromDisplayJson } from '@/lib/groups/codec.js';
import { credentialForDrepId, drepIdForCredential, groupIdParam } from '@/lib/groups/ids.js';
import { describeAction, type GroupChanges } from '@/lib/groups/describe.js';
import type { GroupProfileInput } from '@/lib/groups/profileDocs.js';
import { activeAdminKeys, shortHash } from '@/lib/groups/view.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { afterLock, DraftPanel, lockBound, type Outcome, OutcomeNotice, SLOT_HELD, useActionRunner } from './actionFlow.js';
import type { GroupActionView, PolicyView } from './GroupActions.js';
import { buttons, Callout, choice, h3, muted, part, rows, stack } from './groupUi.js';
import PolicyEditor, { type Proposal, PolicyFields, proposalOf, updateIntent } from './PolicyEditor.js';

export interface GroupActionsPanelProps {
  /** The state of the group page island, read with a session. */
  v: GroupActionView;
  /** When the state was read, on the performance clock. */
  fetchedAt: number;
  network: CardanoNetwork;
  profile: GroupProfileInput | null;
  /** Reads the state again. */
  reload: () => Promise<void>;
}

const JOIN_OPEN_NOTE = 'Membership in an open group is self-declared. You are a member once the transaction is confirmed.';
const JOIN_PERMISSIONED_NOTE = 'Membership in this group is confirmed by the group. Your request stays pending until the group approves it.';
const LEAVE_NOTE = 'Leaving is always possible with your own signature, also while your request is pending.';
const LEAVE_WARNING =
  'If you leave, the remaining members in the management policy can no longer reach its threshold. You can update the policy first. Leaving stays possible either way.';
// A join reference standing for any request, mayInitiate does not read it.
const ANY_JOIN = `${'0'.repeat(64)}#0`;

/** The group state the action module works on, rebuilt from the route's display JSON. */
function stateOf(v: GroupActionView): GroupState | null {
  const ref = groupIdParam(v.groupId);
  const policy = (p: PolicyView) => {
    const s = scriptFromDisplayJson(p.json);
    return s ? Object.assign(s, { hash: p.hash }) : null;
  };
  const control = policy(v.control);
  if (!ref || !control) return null;
  const admission = v.admission === null ? null : v.admission.hash === v.control.hash ? control : policy(v.admission);
  if (v.admission !== null && !admission) return null;
  return {
    ref,
    mode: v.mode,
    status: v.status,
    seq: BigInt(v.seq),
    control,
    admission,
    resignedControl: v.resignedControl,
    resignedAdmission: v.resignedAdmission,
  };
}

/** The section an action was opened from, its draft opens in place of that section's form. */
type DraftSource = 'membership' | 'editor' | 'requests' | 'remove';

interface Draft {
  intent: GroupIntent;
  label: string;
  source: DraftSource;
  /** What the transaction does, one line per change. */
  lines: string[];
}

export default function GroupActionsPanel({ v, fetchedAt, network, profile, reload }: GroupActionsPanelProps) {
  const runner = useActionRunner(network);
  const { setError } = runner;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [memberScript, setMemberScript] = useState<NativeScript | null>(null);
  const [signers, setSigners] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<{ o: Outcome; at: DraftSource } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [withUpdate, setWithUpdate] = useState(true);
  const [offer, setOffer] = useState<Proposal | null>(null);
  // The policy editor, open with the proposal it starts from.
  const [editor, setEditor] = useState<{ initial: Proposal | null } | null>(null);
  // Names of admins the editor added by DRep id, the state route does not know them.
  const [addedNames, setAddedNames] = useState<Map<string, string>>(new Map());
  // The active member whose removal waits for the confirmation.
  const [removing, setRemoving] = useState<{ joinId: string; name: string } | null>(null);

  const state = useMemo(() => stateOf(v), [v]);
  const viewerKey = v.viewer?.keyHash ?? null;
  const viewerDrep = v.viewer?.drepId ?? null;
  const scriptViewer = viewerDrep ? credentialForDrepId(viewerDrep)?.kind === 'script' : false;
  // Every key the policies list, resigned ones included, and the admins among them.
  const policyKeys = useMemo(() => new Set([...v.control.keys, ...(v.admission?.keys ?? [])]), [v]);
  const admins = useMemo(() => activeAdminKeys(v.control.keys, v.admission?.keys ?? null, v.resignedControl, v.resignedAdmission), [v]);
  // The control keys that have not resigned from control, and the members that did.
  const activeControl = useMemo(() => [...activeAdminKeys(v.control.keys, null, v.resignedControl, [])], [v]);
  const resignedControl = useMemo(() => new Set(v.resignedControl.map((k) => k.toLowerCase())), [v]);
  const isAdmin = viewerKey !== null && admins.has(viewerKey);
  const activeIds = useMemo(() => v.activeKeyMembers.map((m) => m.drepId), [v]);
  // Members a new management policy is offered with: a member that resigned from control stays out.
  const policyIds = useMemo(() => v.activeKeyMembers.filter((m) => !resignedControl.has(m.keyHash.toLowerCase())).map((m) => m.drepId), [v, resignedControl]);
  const memberKeys = useMemo(() => new Set(v.activeKeyMembers.map((m) => m.keyHash)), [v]);
  // Policy keys of neither an active member nor an applicant: DReps that left or were removed.
  const formerKeys = useMemo(() => {
    const applicants = new Set(
      v.pending.flatMap((p) => {
        const c = credentialForDrepId(p.drepId);
        return c?.kind === 'key' ? [c.hash.toLowerCase()] : [];
      }),
    );
    return new Set([...policyKeys].filter((k) => !memberKeys.has(k) && !applicants.has(k)));
  }, [v, policyKeys, memberKeys]);
  // Names by credential hash, the applicants and members included: the combined offer lists them before the policy names know them.
  const nameMap = useMemo(() => {
    const m = new Map<string, string>(Object.entries(v.names));
    for (const p of [...v.pending, ...v.activeMembers]) {
      const c = credentialForDrepId(p.drepId);
      if (c && p.name) m.set(c.hash.toLowerCase(), p.name);
    }
    for (const [k, n] of addedNames) m.set(k, n);
    return m;
  }, [v, addedNames]);
  const nameOf = useCallback((key: string) => nameMap.get(key) ?? shortHash(drepIdForCredential({ kind: 'key', hash: key })), [nameMap]);
  const current = useMemo(() => (state ? thresholdOf(state.control) : { n: 1, k: 1 }), [state]);
  // The member of every known join, for the words of a draft.
  const joinMembers = useMemo(() => {
    const m = new Map<string, Credential>();
    for (const p of [...v.pending, ...v.activeMembers]) {
      const c = credentialForDrepId(p.drepId);
      if (c) m.set(p.joinId.toLowerCase(), { kind: c.kind, hash: c.hash.toLowerCase() });
    }
    return m;
  }, [v]);

  // The combined offer follows the selected requests: carried from the current policy, at the carried ratio.
  const approvedIds = useMemo(() => v.pending.filter((p) => picked.includes(p.joinId)).map((p) => p.drepId), [v, picked]);
  useEffect(() => {
    if (!state || approvedIds.length === 0) {
      setOffer(null);
      return;
    }
    const p = proposeUpdate(state, activeIds, approvedIds);
    setOffer(sameSet(p.keys, v.control.keys) ? null : proposalOf(p));
  }, [state, activeIds, approvedIds, v]);

  const keysOf = useCallback(
    (intent: GroupIntent, script: NativeScript | null) => {
      try {
        return neededKeys(intent, state, script);
      } catch (err) {
        if (err instanceof IntentError) return null;
        throw err;
      }
    },
    [state],
  );

  /**
   * Signers that satisfy the action: the viewer first, then active members, then the other keys
   * (former members still named in a policy), each group in policy order, until it holds.
   */
  const defaultSigners = useCallback(
    (intent: GroupIntent, script: NativeScript | null, lock: number | undefined): string[] => {
      const keys = keysOf(intent, script);
      if (!keys) return [];
      const rank = (k: string) => (k === viewerKey ? 0 : memberKeys.has(k) ? 1 : 2);
      const order = [...keys.optional].sort((a, b) => rank(a) - rank(b));
      const chosen: string[] = [];
      const holds = () =>
        signerSetSatisfies(state, intent, script, uniq([...keys.mandatory, ...chosen]), { invalidBefore: lockBound(lock), invalidHereafter: null });
      for (const k of order) {
        if (holds()) break;
        chosen.push(k);
      }
      return chosen;
    },
    [keysOf, state, viewerKey, memberKeys],
  );

  async function open(intent: GroupIntent, label: string, source: DraftSource, profileChange?: GroupChanges['profile'], names = nameMap) {
    setError(null);
    setOutcome(null);
    let script: NativeScript | null = null;
    const ownMember = (intent.kind === 'group_join' || intent.kind === 'group_leave') && scriptViewer;
    if (ownMember) {
      // A script DRep's own script decides who signs its join or leave.
      try {
        const res = await fetchWithTimeout('/api/drep/multisig/script');
        if (!res.ok) throw new Error('Could not load your DRep script.');
        const { parseNativeScriptJson } = await import('@/lib/cardano/nativeScript.js');
        const cli = parseNativeScriptJson(((await res.json()) as { value?: unknown }).value);
        if (!cli) throw new Error('Your DRep is not controlled by a supported native script.');
        script = libraryScript(cli);
      } catch (err) {
        setError(readableError(err));
        return;
      }
    }
    setMemberScript(script);
    setSigners(defaultSigners(intent, script, afterLock(script)));
    const lines = describeAction(changesOfIntent(intent, state, { joinMembers, ...(profileChange ? { profile: profileChange } : {}) }), names);
    setDraft({ intent, label, source, lines });
  }

  async function build() {
    if (!draft || !state) return;
    const { intent } = draft;
    const keys = keysOf(intent, memberScript);
    if (!keys) return;
    // The server's clock, moved on by the time since the state was read, since the server bounds
    // the validity end by its own tip and the browser clock may be off by minutes.
    const tipSlot = v.serverSlot + Math.floor((performance.now() - fetchedAt) / 1000);
    const o = await runner.run({ intent, state, memberScript, keys, signers, viewerKey, tipSlot });
    // Once the action exists the forms close, so a second click cannot open the same action again.
    if (o) {
      setOutcome({ o, at: draft.source });
      setDraft(null);
      setPicked([]);
      setEditor(null);
    }
    void reload();
  }

  const active = v.status === 'active' && state !== null;
  const join = v.viewer?.join ?? null;
  const ownJoinOpen = v.rows.some((r) => r.kind === 'group_join' && r.status !== 'cancelled');
  const ownLeaveOpen = v.rows.some((r) => r.kind === 'group_leave' && r.status !== 'cancelled');
  // The same initiation rule as the server, so no control is offered that the server would refuse.
  const session = { keyHash: viewerKey, drepId: viewerDrep };
  const allowed = (intent: GroupIntent): boolean => state !== null && mayInitiate(intent, state, session);
  const canApprove = allowed({ kind: 'group_approve', group: v.groupId, joins: [] });
  const canRemove = allowed({ kind: 'group_remove', group: v.groupId, joins: [] });
  const canUpdate = allowed({ kind: 'group_update', group: v.groupId, approvals: [] });
  // Only whether approvals are present decides the policies a combined update needs.
  const canCombined = allowed({ kind: 'group_update', group: v.groupId, approvals: [ANY_JOIN] });
  // A key that may only open the combined update approves with the update, without a decline.
  const updateForced = !canApprove && canCombined;
  const useUpdate = offer !== null && !v.openControl && offer.ticked.length > 0 && canCombined && (withUpdate || updateForced);
  const approveOk = picked.length > 0 && (useUpdate || canApprove);
  const controlKeys = v.control.keys;
  // The drift compares the admins of control with the members that have not resigned from it.
  const policyMembers = [...memberKeys].filter((k) => !resignedControl.has(k.toLowerCase()));
  const drift = v.mode === 'permissioned' && !sameSet(activeControl, policyMembers);
  const notInPolicy = policyMembers.filter((k) => !activeControl.includes(k.toLowerCase()));
  const formerInPolicy = activeControl.filter((k) => !memberKeys.has(k));
  // Signer labels mark policy keys of DReps that are no longer members, applicants are not marked.
  const signerName = (key: string) =>
    formerKeys.has(key) ? `${nameOf(key)} (no longer a member)` : nameOf(key);
  const driftText = [
    `The group is still managed by: ${activeControl.map(nameOf).join(', ')}.`,
    notInPolicy.length > 0 ? `Members not in the policy: ${notInPolicy.map(nameOf).join(', ')}.` : '',
    formerInPolicy.length > 0 ? `No longer members: ${formerInPolicy.map(nameOf).join(', ')}.` : '',
  ]
    .filter((s) => s !== '')
    .join(' ');
  // An admin's leave that leaves the remaining member admins short of the control threshold.
  const leaveWarning =
    state !== null &&
    join !== null &&
    viewerKey !== null &&
    activeControl.includes(viewerKey) &&
    !evaluateNativeScript(state.control, {
      signers: new Set(activeControl.filter((k) => k !== viewerKey && memberKeys.has(k))),
      invalidBefore: null,
      invalidHereafter: null,
    });

  const openEditor = (members: string[] | null) => {
    if (!state) return;
    setDraft(null);
    setEditor({ initial: members ? proposalOf(proposeDrift(state, members)) : null });
  };

  const keys = draft ? keysOf(draft.intent, memberScript) : null;
  const required = keys ? uniq([...keys.mandatory, ...signers]) : [];
  const satisfied =
    draft && keys
      ? signerSetSatisfies(state, draft.intent, memberScript, required, {
          invalidBefore: lockBound(afterLock(memberScript)),
          invalidHereafter: null,
        })
      : false;
  const canDissolve = allowed({ kind: 'group_dissolve', group: v.groupId });
  // A resign row links only for its own key, so a linked one is the viewer's own resign in progress.
  const ownResignOpen = v.rows.some((r) => r.kind === 'group_resign' && r.id !== null && r.status !== 'cancelled');
  const resignKey = viewerKey !== null && !ownResignOpen && allowed({ kind: 'group_resign', group: v.groupId, key: viewerKey }) ? viewerKey : null;
  const freezes = state !== null && resignKey !== null && resignFreezes(state.control, resignKey, v.resignedControl);
  const canManage = canUpdate || resignKey !== null;
  // Active members the viewer may remove, the viewer's own membership ends with Leave instead.
  const removable =
    active && v.mode === 'permissioned'
      ? v.activeMembers.filter((m) => m.drepId !== viewerDrep && allowed({ kind: 'group_remove', group: v.groupId, joins: [m.joinId] }))
      : [];

  // The signing step of the open draft, shown in place of the form it came from.
  const draftPanel =
    draft && keys ? (
      <DraftPanel
        label={draft.label}
        lines={draft.lines}
        keys={keys}
        signers={signers}
        onSigners={setSigners}
        satisfied={satisfied}
        nameOf={signerName}
        viewerKey={viewerKey}
        runner={runner}
        onBuild={() => void build()}
        onBack={() => setDraft(null)}
      />
    ) : null;
  const drafting = (source: DraftSource) => draftPanel !== null && draft?.source === source;
  // The outcome of a built action shows where its draft was.
  const outcomeAt = (source: DraftSource) => (outcome && outcome.at === source ? <OutcomeNotice outcome={outcome.o} network={network} /> : null);

  return (
    <>
      {active && viewerDrep && drafting('membership') && draftPanel}
      {outcomeAt('membership')}
      {active && viewerDrep && !drafting('membership') && (
        <section aria-label="Your membership" style={part}>
          {join === null ? (
            !ownJoinOpen && (
              <>
                <p style={muted}>{v.mode === 'open' ? JOIN_OPEN_NOTE : JOIN_PERMISSIONED_NOTE}</p>
                <div style={buttons}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      void open({ kind: 'group_join', group: v.groupId, member: viewerDrep }, v.mode === 'open' ? 'Join the group' : 'Request to join', 'membership')
                    }
                  >
                    {v.mode === 'open' ? 'Join' : 'Request to join'}
                  </button>
                </div>
              </>
            )
          ) : (
            <>
              <h3 style={h3}>{join.state === 'pending' ? 'Your request to join is pending' : 'You are a member of this group'}</h3>
              {v.mode === 'permissioned' && <p style={muted}>{LEAVE_NOTE}</p>}
              {leaveWarning && <p style={muted}>{LEAVE_WARNING}</p>}
              {leaveWarning && canUpdate && v.openControl && <p style={muted}>{SLOT_HELD}</p>}
              <div style={buttons}>
                {leaveWarning && canUpdate && !v.openControl && (
                  <button type="button" className="btn" onClick={() => openEditor(policyIds.filter((d) => d !== viewerDrep))}>
                    Update the policy first
                  </button>
                )}
                {!ownLeaveOpen && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void open({ kind: 'group_leave', group: v.groupId, member: viewerDrep, join: join.joinId }, 'Leave the group', 'membership')}
                  >
                    Leave
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {active && drift && (join?.state === 'active' || isAdmin) && !editor && (
        <section aria-label="Management policy" style={part}>
          <Callout kind="info">{driftText}</Callout>
          {canUpdate &&
            (v.openControl ? (
              <p style={muted}>{SLOT_HELD}</p>
            ) : (
              <div style={buttons}>
                <button type="button" className="btn" onClick={() => openEditor(policyIds)}>
                  Update the policy
                </button>
              </div>
            ))}
        </section>
      )}

      {active && canManage && !editor && (
        <section aria-label="Group management" style={part}>
          <p style={muted}>You are an admin of this group.</p>
          <div style={buttons}>
            <button type="button" className="btn" onClick={() => openEditor(null)}>
              Manage the group
            </button>
          </div>
        </section>
      )}

      {active && canManage && editor && (
        <>
          {/* The editor stays mounted while its draft is open, so Back returns to the filled form. */}
          <div hidden={drafting('editor')}>
            <PolicyEditor
              groupId={v.groupId}
              current={current}
              controlKeys={controlKeys}
              resignedControl={v.resignedControl}
              sameAdmission={v.admission?.hash === v.control.hash}
              listed={new Set(activeControl)}
              memberKeys={[...memberKeys]}
              nameOf={nameOf}
              profile={profile}
              initial={editor.initial}
              slotHeld={v.openControl !== null}
              canUpdate={canUpdate}
              canDissolve={canDissolve}
              resignKey={resignKey}
              resignFreezes={freezes}
              groupName={profile?.name || v.groupId}
              onContinue={(intent, label, names, profileChange) => {
                setAddedNames(names);
                void open(intent, label, 'editor', profileChange, new Map([...nameMap, ...names]));
              }}
              onClose={() => {
                setEditor(null);
                setDraft(null);
              }}
            />
          </div>
          {drafting('editor') && draftPanel}
        </>
      )}
      {outcomeAt('editor')}

      {active && (canApprove || canRemove || canCombined) && v.mode === 'permissioned' && v.pending.length > 0 && (
        drafting('requests') ? (
          draftPanel
        ) : (
          <section aria-label="Requests to join" style={part}>
            <h3 style={h3}>Requests to join</h3>
            <ul style={rows}>
              {v.pending.map((p) => {
                const name = p.name ?? shortHash(p.drepId);
                return (
                  <li key={p.joinId}>
                    <label style={choice}>
                      <input
                        type="checkbox"
                        aria-label={name}
                        checked={picked.includes(p.joinId)}
                        onChange={() => setPicked((xs) => (xs.includes(p.joinId) ? xs.filter((x) => x !== p.joinId) : [...xs, p.joinId]))}
                      />
                      {name}
                    </label>
                  </li>
                );
              })}
            </ul>
            {offer &&
              canCombined &&
              (v.openControl ? (
                <p style={muted}>{SLOT_HELD}</p>
              ) : (
                <div style={stack}>
                  {updateForced ? (
                    <p style={muted}>Your key may approve only together with an update of the management policy.</p>
                  ) : (
                    <label style={choice}>
                      <input type="checkbox" checked={withUpdate} onChange={() => setWithUpdate((x) => !x)} />
                      Also update the management policy in the same transaction
                    </label>
                  )}
                  {(withUpdate || updateForced) && <PolicyFields proposal={offer} onChange={setOffer} current={current} listed={new Set(activeControl)} nameOf={nameOf} />}
                </div>
              ))}
            <div style={buttons}>
              {(canApprove || canCombined) && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!approveOk}
                  onClick={() =>
                    void open(
                      useUpdate && offer ? updateIntent(v.groupId, offer, picked) : { kind: 'group_approve', group: v.groupId, joins: picked },
                      'Approve',
                      'requests',
                    )
                  }
                >
                  Approve
                </button>
              )}
              {canRemove && (
                <button
                  type="button"
                  className="btn"
                  disabled={picked.length === 0}
                  onClick={() => void open({ kind: 'group_remove', group: v.groupId, joins: picked }, 'Remove', 'requests')}
                >
                  Remove
                </button>
              )}
            </div>
          </section>
        )
      )}
      {outcomeAt('requests')}

      {removable.length > 0 && (
        drafting('remove') ? (
          draftPanel
        ) : (
          <section aria-label="Remove members" style={part}>
            <h3 style={h3}>Remove members</h3>
            <ul style={rows}>
              {removable.map((m) => {
                const name = m.name ?? shortHash(m.drepId);
                return (
                  <li key={m.joinId} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>{name}</span>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Remove ${name}`}
                      onClick={() => {
                        setDraft(null);
                        setRemoving({ joinId: m.joinId, name });
                      }}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
            {removing && (
              <Callout kind="info">
                <p style={{ margin: '0 0 0.5rem' }}>Remove {removing.name} from the group? Their delegations do not change.</p>
                <div style={buttons}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setRemoving(null);
                      void open({ kind: 'group_remove', group: v.groupId, joins: [removing.joinId] }, `Remove ${removing.name}`, 'remove');
                    }}
                  >
                    Yes, remove
                  </button>
                  <button type="button" className="btn" onClick={() => setRemoving(null)}>
                    Cancel
                  </button>
                </div>
              </Callout>
            )}
          </section>
        )
      )}

      {outcomeAt('remove')}
      {/* An error while a draft is open shows in the draft. */}
      {runner.error && !draftPanel && <Callout kind="error">{runner.error}</Callout>}
    </>
  );
}
