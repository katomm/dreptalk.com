// The signed-in part of a DRep group page, loaded only for a session: joining, requesting to join
// and leaving, the request queue of the admins with approve or remove and the offer to update the
// management policy in the same transaction, the notice when the policy keys drifted from the
// members, and the policy editor. Every action is built in the browser and either completes in one
// wallet step or gives a link.
import { evaluateNativeScript, type NativeScript } from 'drep-groups';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardanoNetwork } from '@/lib/config/network.js';
import {
  type GroupIntent,
  type GroupState,
  IntentError,
  mayInitiate,
  neededKeys,
  proposeDrift,
  proposeUpdate,
  sameSet,
  signerSetSatisfies,
  thresholdOf,
  uniq,
} from '@/lib/groups/actions.js';
import { libraryScript, scriptFromDisplayJson } from '@/lib/groups/codec.js';
import { credentialForDrepId, drepIdForCredential, groupIdParam } from '@/lib/groups/ids.js';
import type { GroupProfileInput } from '@/lib/groups/profileDocs.js';
import { shortHash } from '@/lib/groups/view.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { afterLock, DraftPanel, lockBound, type Outcome, OutcomeNotice, SLOT_HELD, useActionRunner } from './actionFlow.js';
import type { GroupActionView, PolicyView } from './GroupActions.js';
import { Callout, h2, muted, stack } from './groupUi.js';
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
  return { ref, mode: v.mode, status: v.status, seq: BigInt(v.seq), control, admission };
}

interface Draft {
  intent: GroupIntent;
  label: string;
}

export default function GroupActionsPanel({ v, fetchedAt, network, profile, reload }: GroupActionsPanelProps) {
  const runner = useActionRunner(network);
  const { setError } = runner;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [memberScript, setMemberScript] = useState<NativeScript | null>(null);
  const [signers, setSigners] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [withUpdate, setWithUpdate] = useState(true);
  const [offer, setOffer] = useState<Proposal | null>(null);
  // The policy editor, open with the proposal it starts from.
  const [editor, setEditor] = useState<{ initial: Proposal | null } | null>(null);
  // Names of admins the editor added by DRep id, the state route does not know them.
  const [addedNames, setAddedNames] = useState<Map<string, string>>(new Map());

  const state = useMemo(() => stateOf(v), [v]);
  const viewerKey = v.viewer?.keyHash ?? null;
  const viewerDrep = v.viewer?.drepId ?? null;
  const scriptViewer = viewerDrep ? credentialForDrepId(viewerDrep)?.kind === 'script' : false;
  const policyKeys = useMemo(() => new Set([...v.control.keys, ...(v.admission?.keys ?? [])]), [v]);
  const isAdmin = viewerKey !== null && policyKeys.has(viewerKey);
  const activeIds = useMemo(() => v.activeKeyMembers.map((m) => m.drepId), [v]);
  // Applicants by key hash, the combined offer lists them before the policy names know them.
  const pendingNames = useMemo(
    () =>
      new Map(
        v.pending.flatMap((p) => {
          const c = credentialForDrepId(p.drepId);
          return c?.kind === 'key' && p.name ? [[c.hash.toLowerCase(), p.name] as const] : [];
        }),
      ),
    [v],
  );
  const nameOf = useCallback(
    (key: string) =>
      v.names[key] ??
      addedNames.get(key) ??
      pendingNames.get(key) ??
      shortHash(drepIdForCredential({ kind: 'key', hash: key })),
    [v, addedNames, pendingNames],
  );
  const current = useMemo(() => (state ? thresholdOf(state.control) : { n: 1, k: 1 }), [state]);

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

  /** Signers that satisfy the action, the viewer first, then the other keys in order until it holds. */
  const defaultSigners = useCallback(
    (intent: GroupIntent, script: NativeScript | null, lock: number | undefined): string[] => {
      const keys = keysOf(intent, script);
      if (!keys) return [];
      const order = [...keys.optional].sort((a, b) => (a === viewerKey ? -1 : b === viewerKey ? 1 : 0));
      const chosen: string[] = [];
      const holds = () =>
        signerSetSatisfies(state, intent, script, uniq([...keys.mandatory, ...chosen]), { invalidBefore: lockBound(lock), invalidHereafter: null });
      for (const k of order) {
        if (holds()) break;
        chosen.push(k);
      }
      return chosen;
    },
    [keysOf, state, viewerKey],
  );

  async function open(intent: GroupIntent, label: string) {
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
    setDraft({ intent, label });
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
      setOutcome(o);
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
  const memberKeys = v.activeKeyMembers.map((m) => m.keyHash);
  const drift = v.mode === 'permissioned' && !sameSet(controlKeys, memberKeys);
  const notInPolicy = memberKeys.filter((k) => !controlKeys.includes(k));
  const formerInPolicy = controlKeys.filter((k) => !memberKeys.includes(k));
  const driftText = [
    `The group is still managed by: ${controlKeys.map(nameOf).join(', ')}.`,
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
    controlKeys.includes(viewerKey) &&
    !evaluateNativeScript(state.control, {
      signers: new Set(controlKeys.filter((k) => k !== viewerKey && memberKeys.includes(k))),
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

  return (
    <>
      {active && viewerDrep && (
        <section aria-label="Your membership" style={stack}>
          {join === null ? (
            !ownJoinOpen && (
              <>
                <p style={muted}>{v.mode === 'open' ? JOIN_OPEN_NOTE : JOIN_PERMISSIONED_NOTE}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() =>
                    void open({ kind: 'group_join', group: v.groupId, member: viewerDrep }, v.mode === 'open' ? 'Join the group' : 'Request to join')
                  }
                >
                  {v.mode === 'open' ? 'Join' : 'Request to join'}
                </button>
              </>
            )
          ) : (
            <>
              <p style={{ margin: 0 }}>{join.state === 'pending' ? 'Your request to join is pending.' : 'You are a member of this group.'}</p>
              {v.mode === 'permissioned' && <p style={muted}>{LEAVE_NOTE}</p>}
              {leaveWarning && (
                <>
                  <p style={muted}>{LEAVE_WARNING}</p>
                  {!canUpdate ? null : v.openControl ? (
                    <p style={muted}>{SLOT_HELD}</p>
                  ) : (
                    <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => openEditor(activeIds.filter((d) => d !== viewerDrep))}>
                      Update the policy first
                    </button>
                  )}
                </>
              )}
              {!ownLeaveOpen && (
              <button
                type="button"
                className="btn"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => void open({ kind: 'group_leave', group: v.groupId, member: viewerDrep, join: join.joinId }, 'Leave the group')}
              >
                Leave
              </button>
              )}
            </>
          )}
        </section>
      )}

      {active && drift && (join?.state === 'active' || isAdmin) && (
        <section aria-label="Management policy" style={stack}>
          <p style={muted}>{driftText}</p>
          {canUpdate &&
            (v.openControl ? (
              <p style={muted}>{SLOT_HELD}</p>
            ) : (
              <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => openEditor(activeIds)}>
                Update the policy
              </button>
            ))}
        </section>
      )}

      {active && canUpdate && !editor && (
        <section aria-label="Group management" style={stack}>
          <p style={muted}>You are an admin of this group.</p>
          <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => openEditor(null)}>
            Manage the group
          </button>
        </section>
      )}

      {active && canUpdate && editor && (
        <PolicyEditor
          groupId={v.groupId}
          current={current}
          controlKeys={controlKeys}
          sameAdmission={v.admission?.hash === v.control.hash}
          listed={policyKeys}
          memberKeys={memberKeys}
          nameOf={nameOf}
          profile={profile}
          initial={editor.initial}
          slotHeld={v.openControl !== null}
          canDissolve={canDissolve}
          onContinue={(intent, label, names) => {
            setAddedNames(names);
            void open(intent, label);
          }}
          onClose={() => {
            setEditor(null);
            setDraft(null);
          }}
        />
      )}

      {active && (canApprove || canRemove || canCombined) && v.mode === 'permissioned' && v.pending.length > 0 && (
        <section aria-label="Requests to join" style={stack}>
          <h2 style={h2}>Requests to join</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.25rem' }}>
            {v.pending.map((p) => {
              const name = p.name ?? shortHash(p.drepId);
              return (
                <li key={p.joinId}>
                  <label style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}>
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
                  <label style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center', fontSize: '0.875rem' }}>
                    <input type="checkbox" checked={withUpdate} onChange={() => setWithUpdate((x) => !x)} />
                    Also update the management policy in the same transaction
                  </label>
                )}
                {(withUpdate || updateForced) && <PolicyFields proposal={offer} onChange={setOffer} current={current} listed={policyKeys} nameOf={nameOf} />}
              </div>
            ))}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {(canApprove || canCombined) && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!approveOk}
                onClick={() =>
                  void open(
                    useUpdate && offer ? updateIntent(v.groupId, offer, picked) : { kind: 'group_approve', group: v.groupId, joins: picked },
                    'Approve',
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
                onClick={() => void open({ kind: 'group_remove', group: v.groupId, joins: picked }, 'Remove')}
              >
                Remove
              </button>
            )}
          </div>
        </section>
      )}

      {draft && keys && (
        <DraftPanel
          label={draft.label}
          keys={keys}
          signers={signers}
          onSigners={setSigners}
          satisfied={satisfied}
          nameOf={nameOf}
          viewerKey={viewerKey}
          runner={runner}
          onBuild={() => void build()}
          onBack={() => setDraft(null)}
        />
      )}

      {outcome && <OutcomeNotice outcome={outcome} network={network} />}
      {runner.error && <Callout kind="error">{runner.error}</Callout>}
    </>
  );
}
