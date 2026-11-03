// React island of a DRep group page: joining, requesting to join and leaving, the request queue of
// the admins with approve or remove and the offer to update the management policy in the same
// transaction, the notice when the policy keys drifted from the members, and the group actions in
// progress. The state comes from a session aware route, so the page around it stays cacheable.
// Every action is built in the browser and either completes in one wallet step or gives a link.
import { evaluateNativeScript, type NativeScript } from 'drep-groups';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardanoNetwork } from '@/lib/config/network.js';
import {
  type GroupIntent,
  type GroupState,
  IntentError,
  mayInitiate,
  neededKeys,
  proposeDrift,
  proposeUpdate,
  signerSetSatisfies,
  thresholdOf,
  uniq,
} from '@/lib/groups/actions.js';
import { libraryScript, scriptFromDisplayJson } from '@/lib/groups/codec.js';
import { credentialForDrepId, drepIdForCredential, groupIdParam } from '@/lib/groups/ids.js';
import type { GroupProfileInput } from '@/lib/groups/profileDocs.js';
import { ACTION_KIND_LABEL, ACTION_STATUS_LABEL, shortHash } from '@/lib/groups/view.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { afterLock, Callout, DraftPanel, h2, muted, type Outcome, OutcomeNotice, SLOT_HELD, stack, useActionRunner } from './actionFlow.js';
import PolicyEditor, { type Proposal, PolicyFields, proposalOf } from './PolicyEditor.js';

export interface PolicyView {
  hash: string;
  /** Display JSON of the native script. */
  json: string;
  keys: string[];
}

/** Shape returned by GET /api/groups/[id]/state. */
export interface GroupActionView {
  groupId: string;
  mode: 'open' | 'permissioned';
  status: 'active' | 'dissolved';
  seq: string;
  /** The server's wall clock slot when the state was read, the client clock may be off. */
  serverSlot: number;
  control: PolicyView;
  admission: PolicyView | null;
  /** DRep names by key hash. */
  names: Record<string, string>;
  activeKeyMembers: Array<{ drepId: string; keyHash: string; name: string | null }>;
  pending: Array<{ joinId: string; drepId: string; name: string | null }>;
  openControl: { id: string | null } | null;
  rows: Array<{ id: string | null; kind: string; status: string }>;
  viewer: { keyHash: string | null; drepId: string | null; join: { joinId: string; state: 'pending' | 'active' } | null } | null;
}

export interface GroupActionsProps {
  groupId: string;
  network: CardanoNetwork;
  /** The group's current profile, the policy editor starts from it. */
  profile?: GroupProfileInput | null;
}

const JOIN_OPEN_NOTE = 'Membership in an open group is self-declared. You are a member once the transaction is confirmed.';
const JOIN_PERMISSIONED_NOTE = 'Membership in this group is confirmed by the group. Your request stays pending until the group approves it.';
const LEAVE_NOTE = 'Leaving is always possible with your own signature, also while your request is pending.';
const LEAVE_WARNING =
  'If you leave, the remaining members in the management policy can no longer reach its threshold. You can update the policy first. Leaving stays possible either way.';
// A join reference standing for any request, mayInitiate does not read it.
const ANY_JOIN = `${'0'.repeat(64)}#0`;

const sameKeys = (a: string[], b: string[]): boolean => {
  const x = uniq(a);
  const y = uniq(b);
  return x.length === y.length && x.every((k, i) => k === y[i]);
};

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

export default function GroupActions({ groupId, network, profile = null }: GroupActionsProps) {
  const runner = useActionRunner(network);
  const { setError } = runner;
  const fetchedAt = useRef(0);
  const [v, setV] = useState<GroupActionView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [memberScript, setMemberScript] = useState<NativeScript | null>(null);
  const [signers, setSigners] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [withUpdate, setWithUpdate] = useState(true);
  const [offer, setOffer] = useState<Proposal | null>(null);
  // The policy editor, open with the proposal it starts from.
  const [editor, setEditor] = useState<{ initial: Proposal | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`/api/groups/${groupId}/state`);
      if (res.ok) {
        const body = (await res.json()) as GroupActionView;
        fetchedAt.current = performance.now();
        setV(body);
      }
    } catch {
      // The island stays empty, the page around it is complete without it.
    }
  }, [groupId]);
  useEffect(() => {
    void load();
  }, [load]);

  const state = useMemo(() => (v ? stateOf(v) : null), [v]);
  const viewerKey = v?.viewer?.keyHash ?? null;
  const viewerDrep = v?.viewer?.drepId ?? null;
  const scriptViewer = viewerDrep ? credentialForDrepId(viewerDrep)?.kind === 'script' : false;
  const policyKeys = useMemo(() => new Set(v ? [...v.control.keys, ...(v.admission?.keys ?? [])] : []), [v]);
  const isAdmin = viewerKey !== null && policyKeys.has(viewerKey);
  const activeIds = useMemo(() => v?.activeKeyMembers.map((m) => m.drepId) ?? [], [v]);
  const nameOf = useCallback(
    (key: string) => v?.names[key] ?? v?.activeKeyMembers.find((m) => m.keyHash === key)?.name ?? shortHash(drepIdForCredential({ kind: 'key', hash: key })),
    [v],
  );
  const current = useMemo(() => (state ? thresholdOf(state.control) : { n: 1, k: 1 }), [state]);

  // The combined offer follows the selected requests: carried from the current policy, at the carried ratio.
  const approvedIds = useMemo(() => (v ? v.pending.filter((p) => picked.includes(p.joinId)).map((p) => p.drepId) : []), [v, picked]);
  useEffect(() => {
    if (!state || approvedIds.length === 0) {
      setOffer(null);
      return;
    }
    const p = proposeUpdate(state, activeIds, approvedIds);
    setOffer(sameKeys(p.keys, v?.control.keys ?? []) ? null : proposalOf(p));
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
        signerSetSatisfies(state, intent, script, uniq([...keys.mandatory, ...chosen]), { invalidBefore: lock === undefined ? null : BigInt(lock), invalidHereafter: null });
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
    const tipSlot = (v?.serverSlot ?? 0) + Math.floor((performance.now() - fetchedAt.current) / 1000);
    const o = await runner.run({ intent, state, memberScript, keys, signers, viewerKey, tipSlot });
    // Once the action exists the forms close, so a second click cannot open the same action again.
    if (o) {
      setOutcome(o);
      setDraft(null);
      setPicked([]);
      setEditor(null);
    }
    void load();
  }

  if (!v) return null;

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
  const drift = v.mode === 'permissioned' && !sameKeys(controlKeys, memberKeys);
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
  const policyIntent = (p: Proposal, approvals: string[]): GroupIntent => ({
    kind: 'group_update',
    group: v.groupId,
    approvals,
    control: { keys: p.ticked, n: p.n },
    ...(p.sameAdmission ? { admission: 'same' as const } : {}),
  });

  const keys = draft ? keysOf(draft.intent, memberScript) : null;
  const required = keys ? uniq([...keys.mandatory, ...signers]) : [];
  const satisfied =
    draft && keys
      ? signerSetSatisfies(state, draft.intent, memberScript, required, {
          invalidBefore: afterLock(memberScript) === undefined ? null : BigInt(afterLock(memberScript) as number),
          invalidHereafter: null,
        })
      : false;
  const canDissolve = allowed({ kind: 'group_dissolve', group: v.groupId });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '40rem' }}>
      {v.rows.length > 0 && (
        <section aria-label="Group actions in progress">
          <h2 style={h2}>In progress</h2>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'grid', gap: '0.25rem' }}>
            {v.rows.map((r, i) => (
              <li key={r.id ?? `row-${i}`}>
                {ACTION_KIND_LABEL[r.kind] ?? r.kind}: {ACTION_STATUS_LABEL[r.status] ?? r.status}
                {r.id && (
                  <>
                    {' '}
                    <a href={`/groups/sign/${r.id}/`}>Open the signing page</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

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
          onContinue={(intent, label) => void open(intent, label)}
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
                    useUpdate && offer ? policyIntent(offer, picked) : { kind: 'group_approve', group: v.groupId, joins: picked },
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
    </div>
  );
}
