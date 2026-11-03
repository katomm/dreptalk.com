// React island of a DRep group page: joining, requesting to join and leaving, the request queue of
// the admins with approve or remove and the offer to update the management policy in the same
// transaction, the notice when the policy keys drifted from the members, and the group actions in
// progress. The state comes from a session aware route, so the page around it stays cacheable.
// Every action is built in the browser and either completes in one wallet step or gives a link.
import { encodePayload, evaluateNativeScript, type NativeScript } from 'drep-groups';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from '@/components/CopyButton.js';
import WalletConnection from '@/components/WalletConnection.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import type { WalletApi } from '@/lib/governance/walletUtxos.js';
import {
  carryThreshold,
  expectedPayload,
  type GroupIntent,
  type GroupState,
  IntentError,
  mayInitiate,
  moreThanHalf,
  neededKeys,
  proposeDrift,
  proposeUpdate,
  signerSetSatisfies,
  thresholdOf,
  uniq,
} from '@/lib/groups/actions.js';
import { libraryScript, scriptFromDisplayJson } from '@/lib/groups/codec.js';
import { ACTION_TTL_SECONDS } from '@/lib/groups/constants.js';
import { credentialForDrepId, drepIdForCredential, groupIdParam } from '@/lib/groups/ids.js';
import { ACTION_KIND_LABEL, ACTION_STATUS_LABEL, shortHash } from '@/lib/groups/view.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { rememberWallet, useCardanoWallets } from '@/lib/wallet/useCardanoWallets.js';
import { readableError } from '@/lib/wallet/walletError.js';

type EnabledWalletApi = WalletApi & { getNetworkId(): Promise<number> };

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
}

const JOIN_OPEN_NOTE = 'Membership in an open group is self-declared. You are a member once the transaction is confirmed.';
const JOIN_PERMISSIONED_NOTE = 'Membership in this group is confirmed by the group. Your request stays pending until the group approves it.';
const LEAVE_NOTE = 'Leaving is always possible with your own signature, also while your request is pending.';
const LEAVE_WARNING =
  'If you leave, the remaining members in the management policy can no longer reach its threshold. You can update the policy first. Leaving stays possible either way.';
// A join reference standing for any request, mayInitiate does not read it.
const ANY_JOIN = `${'0'.repeat(64)}#0`;
const SLOT_HELD = 'Another management action is open, so the policy cannot be changed until it is resolved or expires.';

const muted = { color: 'var(--muted)', fontSize: '0.875rem', margin: 0 } as const;
const h2 = { fontSize: '1.0625rem', margin: '0 0 0.5rem' } as const;
const stack = { display: 'flex', flexDirection: 'column', gap: '0.5rem' } as const;

function Callout({ kind, children }: { kind: 'error' | 'info' | 'success'; children: React.ReactNode }) {
  return (
    <div className={`callout callout--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="callout__body">{children}</div>
    </div>
  );
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ? `${fallback} ${body.error}.` : fallback;
}

const post = (url: string, body?: unknown) =>
  fetchWithTimeout(url, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

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

/** The latest after lock of a member script, the earliest slot its transactions may be valid from. */
function afterLock(s: NativeScript | null): number | undefined {
  if (!s) return undefined;
  if (s.type === 'after') return Number(s.slot);
  if (s.type === 'all' || s.type === 'any' || s.type === 'nOfK') {
    const locks = s.scripts.map(afterLock).filter((x): x is number => x !== undefined);
    return locks.length > 0 ? Math.max(...locks) : undefined;
  }
  return undefined;
}

/** The policy proposal a form edits: the keys offered, those ticked and the threshold. */
interface Proposal {
  keys: string[];
  ticked: string[];
  n: number;
  sameAdmission: boolean;
}

const proposalOf = (p: { keys: string[]; n: number; sameAdmission: boolean }): Proposal => ({ keys: p.keys, ticked: p.keys, n: p.n, sameAdmission: p.sameAdmission });

function PolicyFields({
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
  const newlyListed = proposal.ticked.some((x) => !listed.has(x));
  return (
    <div style={stack}>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.25rem' }}>
        {proposal.keys.map((key) => (
          <li key={key}>
            <label style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}>
              <input type="checkbox" checked={proposal.ticked.includes(key)} onChange={() => toggle(key)} aria-label={nameOf(key)} />
              {nameOf(key)}
            </label>
          </li>
        ))}
      </ul>
      {k > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center', fontSize: '0.875rem' }}>
            Threshold
            <input
              type="number"
              min={1}
              max={k}
              value={proposal.n}
              onChange={(e) => onChange({ ...proposal, n: Math.min(k, Math.max(1, Number(e.target.value) || 1)) })}
              style={{ width: '4rem' }}
            />
          </label>
          <span style={{ fontSize: '0.875rem' }}>
            {proposal.n} of {k} must sign ({Math.round((100 * proposal.n) / k)}%)
          </span>
          <button type="button" className="btn" onClick={() => onChange({ ...proposal, n: moreThanHalf(k) })}>
            More than half
          </button>
        </div>
      )}
      {newlyListed && <p style={muted}>Each newly listed member has to sign the update.</p>}
    </div>
  );
}

interface Draft {
  intent: GroupIntent;
  label: string;
}

type Outcome = { link: string } | { submitted: string } | { slotTaken: string | null };

export default function GroupActions({ groupId, network }: GroupActionsProps) {
  const { wallets, selected: walletKey, setSelected: setWalletKey } = useCardanoWallets({ preferCip95: true });
  const apiRef = useRef<EnabledWalletApi | null>(null);
  const fetchedAt = useRef(0);
  const [v, setV] = useState<GroupActionView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [memberScript, setMemberScript] = useState<NativeScript | null>(null);
  const [signers, setSigners] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [withUpdate, setWithUpdate] = useState(true);
  const [offer, setOffer] = useState<Proposal | null>(null);
  const [policyForm, setPolicyForm] = useState<Proposal | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

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

  const connect = useCallback(async (): Promise<EnabledWalletApi | null> => {
    if (apiRef.current) return apiRef.current;
    const info = wallets.find((w) => w.key === walletKey);
    if (!info) {
      setError('Select a wallet to continue.');
      return null;
    }
    try {
      const api = (await info.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;
      await assertWalletNetwork(api, network);
      apiRef.current = api;
      rememberWallet(walletKey);
      return api;
    } catch (err) {
      setError(readableError(err));
      return null;
    }
  }, [wallets, walletKey, network]);

  async function build() {
    if (!draft || !state) return;
    const { intent } = draft;
    const keys = keysOf(intent, memberScript);
    if (!keys) return;
    setError(null);
    setBusy(true);
    let id: string | null = null;
    // Once the action exists the forms close, so a second click cannot open the same action again.
    const finish = (o: Outcome) => {
      setOutcome(o);
      setDraft(null);
      setPicked([]);
      setPolicyForm(null);
    };
    try {
      const api = await connect();
      if (!api) return;
      const { buildGroupTx } = await import('@/lib/groups/groupTx.js');
      // The server's clock, moved on by the time since the state was read, since the server bounds
      // the validity end by its own tip and the browser clock may be off by minutes.
      const tipSlot = (v?.serverSlot ?? 0) + Math.floor((performance.now() - fetchedAt.current) / 1000);
      const lock = afterLock(memberScript);
      const required = uniq([...keys.mandatory, ...signers]);
      const interval = { invalidBefore: lock === undefined ? null : BigInt(lock), invalidHereafter: BigInt(tipSlot + ACTION_TTL_SECONDS) };
      if (!signerSetSatisfies(state, intent, memberScript, required, interval)) {
        throw new Error('The selected signers do not satisfy the policies of this action.');
      }
      const payload = encodePayload(expectedPayload(intent, state, new Map()));
      const { unsignedTxHex } = await buildGroupTx({
        walletApi: api,
        network,
        origin,
        payload,
        requiredSigners: required,
        optionalKeys: keys.optional,
        tipSlot,
        invalidBeforeSlot: lock,
      });
      const res = await post('/api/groups/actions', { intent, unsignedTxCbor: unsignedTxHex, selected: signers });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { id?: string | null };
        finish({ slotTaken: body.id ?? null });
        return;
      }
      if (!res.ok) throw new Error(await errorOf(res, 'Could not open the action.'));
      id = ((await res.json()) as { id: string }).id;
      const solo = !memberScript && viewerKey !== null && required.length === 1 && required[0] === viewerKey;
      if (!solo) {
        finish({ link: id });
        return;
      }
      const witnessSetHex = await api.signTx(unsignedTxHex, true);
      const witness = await post(`/api/groups/actions/${id}/witness`, { witnessSetHex });
      if (!witness.ok) throw new Error(await errorOf(witness, 'Could not add the signature.'));
      const assembled = await post(`/api/groups/actions/${id}/submit`);
      if (!assembled.ok) throw new Error(await errorOf(assembled, 'Could not assemble the transaction.'));
      const { assembledTxHex } = (await assembled.json()) as { assembledTxHex: string };
      const txHash = await api.submitTx(assembledTxHex);
      await post(`/api/groups/actions/${id}/submitted`, { txHash }).catch(() => null);
      finish({ submitted: txHash });
    } catch (err) {
      setError(readableError(err));
      // The action exists, it can still be finished on its signing page.
      if (id) finish({ link: id });
    } finally {
      setBusy(false);
      void load();
    }
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

  const openPolicyForm = (members: string[]) => {
    if (!state) return;
    setDraft(null);
    setPolicyForm(proposalOf(proposeDrift(state, members)));
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
  const choosable = keys ? keys.optional.filter((k) => k !== viewerKey || keys.optional.length > 1) : [];

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
                    <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => openPolicyForm(activeIds.filter((d) => d !== viewerDrep))}>
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
              <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => openPolicyForm(activeIds)}>
                Update the policy
              </button>
            ))}
        </section>
      )}

      {active && policyForm && (
        <section aria-label="Policy update" style={stack}>
          <h2 style={h2}>Update the management policy</h2>
          <PolicyFields proposal={policyForm} onChange={setPolicyForm} current={current} listed={policyKeys} nameOf={nameOf} />
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={policyForm.ticked.length === 0}
              onClick={() => void open(policyIntent(policyForm, []), 'Update the management policy')}
            >
              Continue
            </button>
            <button type="button" className="btn" onClick={() => setPolicyForm(null)}>
              Close
            </button>
          </div>
        </section>
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
        <section aria-label={draft.label} style={stack}>
          <h2 style={h2}>{draft.label}</h2>
          {keys.mandatory.length > 0 && <p style={muted}>Must sign: {keys.mandatory.map(nameOf).join(', ')}</p>}
          {choosable.length > 0 && (
            <>
              <p style={{ margin: 0, fontWeight: 600, fontSize: '0.875rem' }}>Who signs</p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.25rem' }}>
                {keys.optional.map((k) => (
                  <li key={k}>
                    <label style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={`Signer ${nameOf(k)}`}
                        checked={signers.includes(k)}
                        onChange={() => setSigners((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : uniq([...xs, k])))}
                      />
                      {nameOf(k)}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!satisfied && <p style={muted}>These signers do not satisfy the policies of this action yet.</p>}
          {wallets.length === 0 ? (
            <p style={muted}>No Cardano wallet extension detected.</p>
          ) : (
            <WalletConnection wallets={wallets} selected={walletKey} onSelect={setWalletKey} disabled={busy} label="Wallet that pays the fee" />
          )}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn-primary" disabled={busy || !satisfied || wallets.length === 0} onClick={() => void build()}>
              Build and sign
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setDraft(null)}>
              Back
            </button>
          </div>
        </section>
      )}

      {outcome && 'link' in outcome && (
        <Callout kind="info">
          Share this signing link with the other signers: {`${origin}/groups/sign/${outcome.link}/`}{' '}
          <CopyButton value={`${origin}/groups/sign/${outcome.link}/`} label="Copy link" /> <a href={`/groups/sign/${outcome.link}/`}>Open the signing page</a>
        </Callout>
      )}
      {outcome && 'submitted' in outcome && (
        <Callout kind="success">
          Submitted. It shows as confirming until the chain confirms it.{' '}
          <a href={txExplorerUrl(network, outcome.submitted)} target="_blank" rel="noopener noreferrer">
            View transaction
          </a>
        </Callout>
      )}
      {outcome && 'slotTaken' in outcome && (
        <Callout kind="info">
          {SLOT_HELD}
          {outcome.slotTaken && (
            <>
              {' '}
              <a href={`/groups/sign/${outcome.slotTaken}/`}>Open the signing page</a>
            </>
          )}
        </Callout>
      )}
      {error && <Callout kind="error">{error}</Callout>}
    </div>
  );
}
