// DRep group actions DRepTalk builds: for a declared intent and the current group state, the payload
// the transaction must carry, the policies and keys it needs, who may open its signing link, the
// binding of a decoded transaction to that payload, and the events in plain words. Pure, no I/O.
//
// String conventions of an intent: `founders`, `member` and the members of a proposal are DRep ids,
// policy `keys` and the `key` of a resign are key hashes (lowercase hex), `group` is the bech32
// group id and join references are `txHash#index` as the library's refKey writes them.
import {
  type Anchor,
  type Credential,
  collectKeyHashes,
  credKey,
  type DecodedPayload,
  encodeNativeScript,
  encodePayload,
  type EventRef,
  evaluateNativeScript,
  type GroupEvent,
  type GroupMode,
  majorityScript,
  type NativeScript,
  nativeScriptHash,
  type PayloadInput,
  type RefLike,
  refKey,
  type TxFacts,
} from 'drep-groups';
import { scriptDisplayJson } from './codec.js';
import { credentialForDrepId, groupIdParam } from './ids.js';
import { type GroupChanges, noChanges } from './describe.js';
import { type ScriptView, scriptFromJson } from './view.js';

type Policy = NativeScript & { hash: string };

export interface GroupState {
  ref: EventRef;
  mode: GroupMode;
  status: 'active' | 'dissolved';
  seq: bigint;
  control: Policy;
  admission: Policy | null;
  /** Keys that resigned from the role. Their `sig` is false when that role's policy is evaluated. */
  resignedControl: string[];
  resignedAdmission: string[];
}

export interface Majority {
  keys: string[];
  n: number;
}

export type GroupIntent =
  | {
      kind: 'group_create';
      mode: GroupMode;
      control: Majority;
      admission: Majority | 'same' | null;
      founders: string[];
      profile: Anchor | null;
    }
  | { kind: 'group_join' | 'group_leave'; group: string; member: string; join?: string }
  | { kind: 'group_approve' | 'group_remove'; group: string; joins: string[] }
  | { kind: 'group_update'; group: string; approvals: string[]; control?: Majority; admission?: Majority | 'same'; profile?: Anchor }
  | { kind: 'group_dissolve'; group: string }
  | { kind: 'group_resign'; group: string; key: string };

/** An intent that does not describe a buildable action. Callers answer it like an EncodeError. */
export class IntentError extends Error {}

const JOIN_REF = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,4})$/;

export function parseJoinRef(s: string): EventRef {
  const m = JOIN_REF.exec(s.toLowerCase());
  if (!m) throw new IntentError(`bad join reference ${s}`);
  return { txHash: m[1], index: Number(m[2]) };
}

function memberCredential(drepId: string): Credential {
  const c = credentialForDrepId(drepId);
  if (!c) throw new IntentError(`bad DRep id ${drepId}`);
  return { kind: c.kind, hash: c.hash.toLowerCase() };
}

function groupRef(intent: Exclude<GroupIntent, { kind: 'group_create' }>, state: GroupState | null): EventRef {
  const ref = groupIdParam(intent.group);
  if (!ref) throw new IntentError(`bad group id ${intent.group}`);
  if (state && refKey(state.ref) !== refKey(ref)) throw new IntentError('group state does not belong to the intent');
  return ref;
}

function requireState(state: GroupState | null): GroupState {
  if (!state) throw new IntentError('unknown group');
  return state;
}

/** n of k over the keys, through the library so thresholds of 0 and above k are refused. */
function majority(m: Majority): Policy {
  const s = majorityScript(
    m.keys.map((k) => k.toLowerCase()),
    m.n,
  );
  return Object.assign(s.script, { hash: s.hash });
}

const hashOf = (s: NativeScript): string => nativeScriptHash(encodeNativeScript(s));
/** Lowercased, deduplicated and sorted. */
export const uniq = (xs: string[]): string[] => [...new Set(xs.map((x) => x.toLowerCase()))].sort();

/** The control and admission policy a create founds. */
function createPolicies(intent: Extract<GroupIntent, { kind: 'group_create' }>): { control: Policy; admission: Policy | null } {
  const control = majority(intent.control);
  const admission = intent.admission === 'same' ? control : intent.admission === null ? null : majority(intent.admission);
  return { control, admission };
}

/** The new policies an update sets. `admission: 'same'` follows the new control policy, or the current one. */
function updatePolicies(
  intent: Extract<GroupIntent, { kind: 'group_update' }>,
  state: GroupState,
): { control: Policy | undefined; admission: Policy | undefined } {
  const control = intent.control ? majority(intent.control) : undefined;
  const admission =
    intent.admission === undefined ? undefined : intent.admission === 'same' ? (control ?? state.control) : majority(intent.admission);
  return { control, admission };
}

function founderCredentials(founders: string[]): Credential[] {
  const creds = founders.map(memberCredential);
  if (creds.some((c) => c.kind !== 'key')) throw new IntentError('founders must be key based DReps');
  if (new Set(creds.map(credKey)).size !== creds.length) throw new IntentError('a founder is listed twice');
  return creds;
}

/**
 * Whether a role whose current policy lists the key still counts it, the condition of a valid
 * resign: the group is active and the control or the admission policy lists the key without a
 * resignation from that role.
 */
export function mayResign(state: GroupState, key: string): boolean {
  const k = key.toLowerCase();
  if (state.status !== 'active') return false;
  const listed = (p: NativeScript | null, resigned: readonly string[]) => !!p && policyKeys(p).includes(k) && !resignedSet(resigned).has(k);
  return listed(state.control, state.resignedControl) || listed(state.admission, state.resignedAdmission);
}

function leaveRef(intent: { member: string; join?: string }, joinMembers: Map<string, Credential>): EventRef {
  if (intent.join !== undefined) return parseJoinRef(intent.join);
  const want = credKey(memberCredential(intent.member));
  for (const [ref, c] of joinMembers) if (credKey(c) === want) return parseJoinRef(ref);
  throw new IntentError('no open join of this member');
}

/**
 * The payload the action's transaction must carry. A create lists the create, one join per founder
 * with the local reference of the create and, in a permissioned group, one approval per join. A
 * combined admission lists the approvals first and the update last, so the approvals are judged
 * against the admission policy in force before the update. Key 2 holds only policies that are not
 * already the group's current ones. `joinMembers` maps join references to members and resolves a
 * leave that names no join. The payload is encoded once, so anything the decoder would ignore throws.
 */
export function expectedPayload(intent: GroupIntent, state: GroupState | null, joinMembers: Map<string, Credential>): PayloadInput {
  const out = build(intent, state, joinMembers);
  encodePayload(out);
  return out;
}

function build(intent: GroupIntent, state: GroupState | null, joinMembers: Map<string, Credential>): PayloadInput {
  switch (intent.kind) {
    case 'group_create': {
      const { control, admission } = createPolicies(intent);
      const founders = founderCredentials(intent.founders);
      const events: GroupEvent[] = [
        { tag: 'create', mode: intent.mode, control: control.hash, admission: admission?.hash ?? null, profile: intent.profile },
        ...founders.map((member): GroupEvent => ({ tag: 'join', group: { local: 0 }, member })),
      ];
      if (intent.mode === 'permissioned') {
        events.push(...founders.map((_, i): GroupEvent => ({ tag: 'approve', join: { local: i + 1 } })));
      }
      const scripts = admission && admission.hash !== control.hash ? [control, admission] : [control];
      return { events, scripts };
    }
    case 'group_join':
      return { events: [{ tag: 'join', group: groupRef(intent, state), member: memberCredential(intent.member) }] };
    case 'group_leave':
      groupRef(intent, state);
      return { events: [{ tag: 'leave', join: leaveRef(intent, joinMembers) }] };
    case 'group_approve':
    case 'group_remove': {
      groupRef(intent, state);
      const tag = intent.kind === 'group_approve' ? 'approve' : 'remove';
      return { events: intent.joins.map((j): GroupEvent => ({ tag, join: parseJoinRef(j) })) };
    }
    case 'group_update': {
      const group = groupRef(intent, state);
      const s = requireState(state);
      const { control, admission } = updatePolicies(intent, s);
      const changes: Extract<GroupEvent, { tag: 'update' }>['changes'] = {};
      if (control) changes.control = control.hash;
      if (admission) changes.admission = admission.hash;
      if (intent.profile) changes.profile = intent.profile;
      const current = new Set([s.control.hash, s.admission?.hash]);
      const scripts: NativeScript[] = [];
      for (const p of [control, admission]) {
        if (p && !current.has(p.hash)) {
          current.add(p.hash);
          scripts.push(p);
        }
      }
      const events: GroupEvent[] = [
        ...intent.approvals.map((j): GroupEvent => ({ tag: 'approve', join: parseJoinRef(j) })),
        { tag: 'update', group, seq: s.seq, changes },
      ];
      return scripts.length > 0 ? { events, scripts } : { events };
    }
    case 'group_dissolve': {
      const group = groupRef(intent, state);
      return { events: [{ tag: 'dissolve', group, seq: requireState(state).seq }] };
    }
    case 'group_resign': {
      const group = groupRef(intent, state);
      if (!mayResign(requireState(state), intent.key)) throw new IntentError('key not listed in any role');
      return { events: [{ tag: 'resign', group, key: intent.key.toLowerCase() }] };
    }
  }
}

/**
 * The policies the action is judged against in the current state: the control policy for an
 * update or dissolve, the admission policy for approvals and removes (also those of a combined
 * update), and a script DRep's own script for its join or leave. A create has no current policy,
 * its consent rule needs every listed key instead, and a resign needs only the key's own signature.
 */
export function neededPolicies(
  intent: GroupIntent,
  state: GroupState | null,
  memberScript: NativeScript | null,
): { control: NativeScript | null; admission: NativeScript | null; member: NativeScript | null } {
  switch (intent.kind) {
    case 'group_create':
    case 'group_resign':
      return { control: null, admission: null, member: null };
    case 'group_join':
    case 'group_leave':
      return { control: null, admission: null, member: memberCredential(intent.member).kind === 'script' ? memberScript : null };
    case 'group_approve':
    case 'group_remove':
      return { control: null, admission: requireState(state).admission, member: null };
    case 'group_update': {
      const s = requireState(state);
      return { control: s.control, admission: intent.approvals.length > 0 ? s.admission : null, member: null };
    }
    case 'group_dissolve':
      return { control: requireState(state).control, admission: null, member: null };
  }
}

const policyKeys = (...ps: Array<NativeScript | null | undefined>): string[] =>
  uniq(ps.flatMap((p) => (p ? collectKeyHashes(p) : [])));

/** A needed policy with the keys that resigned from its role. A member script has none. */
interface RolePolicy {
  script: NativeScript;
  resigned: Set<string>;
}

const resignedSet = (keys: readonly string[] | undefined): Set<string> => new Set((keys ?? []).map((k) => k.toLowerCase()));

function neededRoles(intent: GroupIntent, state: GroupState | null, memberScript: NativeScript | null): RolePolicy[] {
  const p = neededPolicies(intent, state, memberScript);
  const roles: RolePolicy[] = [];
  if (p.control) roles.push({ script: p.control, resigned: resignedSet(state?.resignedControl) });
  if (p.admission) roles.push({ script: p.admission, resigned: resignedSet(state?.resignedAdmission) });
  if (p.member) roles.push({ script: p.member, resigned: new Set() });
  return roles;
}

/** Listed keys of the role's policy that have not resigned from the role, the keys whose signature counts. */
const activeKeys = (r: RolePolicy): string[] => policyKeys(r.script).filter((k) => !r.resigned.has(k));

/**
 * Keys the new policy of a role lists and its current policy does not, a key that resigned from
 * the role counting as not listed. A role without a new policy has none.
 */
function newToRole(next: NativeScript | undefined, current: NativeScript | null, resigned: readonly string[]): string[] {
  if (!next) return [];
  const listed = new Set(current ? activeKeys({ script: current, resigned: resignedSet(resigned) }) : []);
  return policyKeys(next).filter((k) => !listed.has(k));
}

/**
 * Keys of the action. Mandatory keys must sign explicitly: every key a create lists and every
 * founder, a key DRep's own key for its join or leave, the resigning key, and every key an update
 * lists in the new policy of a role that the current policy of that role does not list, a resigned
 * key counting as not listed. So a key moving from admission into control signs again. Optional
 * keys are the keys of the needed current policies that have not resigned from the role, of which
 * enough sign to satisfy them.
 */
export function neededKeys(
  intent: GroupIntent,
  state: GroupState | null,
  memberScript: NativeScript | null,
): { mandatory: string[]; optional: string[] } {
  const current = neededPolicyKeys(intent, state, memberScript);
  let mandatory: string[] = [];
  switch (intent.kind) {
    case 'group_create': {
      const { control, admission } = createPolicies(intent);
      mandatory = uniq([...policyKeys(control, admission), ...founderCredentials(intent.founders).map((c) => c.hash)]);
      break;
    }
    case 'group_join':
    case 'group_leave': {
      const c = memberCredential(intent.member);
      if (c.kind === 'key') mandatory = [c.hash];
      break;
    }
    case 'group_update': {
      const s = requireState(state);
      const { control, admission } = updatePolicies(intent, s);
      mandatory = uniq([...newToRole(control, s.control, s.resignedControl), ...newToRole(admission, s.admission, s.resignedAdmission)]);
      break;
    }
    case 'group_resign':
      mandatory = [intent.key.toLowerCase()];
      break;
    default:
      break;
  }
  const must = new Set(mandatory);
  return { mandatory, optional: current.filter((k) => !must.has(k)) };
}

const sameCredential = (a: string | null, b: string): boolean => {
  const ca = a ? credentialForDrepId(a) : null;
  const cb = credentialForDrepId(b);
  return ca !== null && cb !== null && credKey({ kind: ca.kind, hash: ca.hash.toLowerCase() }) === credKey({ kind: cb.kind, hash: cb.hash.toLowerCase() });
};

/**
 * Who may open the signing link: a listed founder for a create, the member for its join or leave,
 * the key itself for its resign while a role still counts it, otherwise a key of a needed current
 * policy that has not resigned from its role. Newly listed keys and the extra keys of a separate
 * admission policy of a create may sign but never initiate.
 */
export function mayInitiate(intent: GroupIntent, state: GroupState | null, session: { keyHash: string | null; drepId: string | null }): boolean {
  switch (intent.kind) {
    case 'group_create':
      return intent.founders.some((f) => sameCredential(session.drepId, f));
    case 'group_join':
    case 'group_leave':
      return sameCredential(session.drepId, intent.member);
    case 'group_resign':
      if (!session.keyHash || !state || session.keyHash.toLowerCase() !== intent.key.toLowerCase()) return false;
      try {
        groupRef(intent, state);
      } catch {
        return false;
      }
      return mayResign(state, intent.key);
    default: {
      // A dissolved group takes no further actions, and the state must be the intent's group.
      if (!session.keyHash || !state || state.status === 'dissolved') return false;
      try {
        groupRef(intent, state);
      } catch {
        return false;
      }
      return neededPolicyKeys(intent, state, null).includes(session.keyHash.toLowerCase());
    }
  }
}

/**
 * Who may open and sign the link: the script DRep itself for its own join or leave, otherwise a
 * session whose key is a mandatory or optional key of the action.
 */
export function maySign(
  intent: GroupIntent,
  state: GroupState | null,
  memberScript: NativeScript | null,
  session: { keyHash: string | null; drepId: string | null },
): boolean {
  if (memberCredentialOf(intent)?.kind === 'script') {
    return sameCredential(session.drepId, (intent as { member: string }).member);
  }
  if (!session.keyHash) return false;
  const { mandatory, optional } = neededKeys(intent, state, memberScript);
  const key = session.keyHash.toLowerCase();
  return mandatory.includes(key) || optional.includes(key);
}

/**
 * Lowercase key hashes of every `sig` leaf of the policies the action needs in the state, without
 * the keys that resigned from the role of that policy. A key resigned from every needed role is
 * left out, its signature counts toward none of them.
 */
export function neededPolicyKeys(intent: GroupIntent, state: GroupState | null, memberScript: NativeScript | null): string[] {
  return uniq(neededRoles(intent, state, memberScript).flatMap(activeKeys));
}

/**
 * True when the signers satisfy every needed policy within the interval and every mandatory key
 * signed. Each role's policy is evaluated without the keys that resigned from that role.
 */
export function signerSetSatisfies(
  state: GroupState | null,
  intent: GroupIntent,
  memberScript: NativeScript | null,
  signers: string[],
  interval: { invalidBefore: bigint | null; invalidHereafter: bigint | null },
): boolean {
  const set = new Set(signers.map((s) => s.toLowerCase()));
  if (memberCredentialOf(intent)?.kind === 'script' && !memberScript) return false;
  for (const r of neededRoles(intent, state, memberScript)) {
    const counted = r.resigned.size === 0 ? set : new Set([...set].filter((k) => !r.resigned.has(k)));
    const ctx = { signers: counted, invalidBefore: interval.invalidBefore, invalidHereafter: interval.invalidHereafter };
    if (!evaluateNativeScript(r.script, ctx)) return false;
  }
  return neededKeys(intent, state, memberScript).mandatory.every((k) => set.has(k));
}

function memberCredentialOf(intent: GroupIntent): Credential | null {
  return intent.kind === 'group_join' || intent.kind === 'group_leave' ? memberCredential(intent.member) : null;
}

const refCanon = (r: RefLike): string => ('local' in r ? `local:${r.local}` : `${r.txHash.toLowerCase()}#${r.index}`);
const anchorCanon = (a: Anchor | null | undefined): string | null => (a ? `${a.url} ${a.dataHash.toLowerCase()}` : null);

/** Every field of an event in a fixed order, hashes lowercased, for a position by position comparison. */
function eventCanon(e: GroupEvent): string {
  switch (e.tag) {
    case 'create':
      return JSON.stringify([e.tag, e.mode, e.control.toLowerCase(), e.admission?.toLowerCase() ?? null, anchorCanon(e.profile)]);
    case 'update':
      return JSON.stringify([
        e.tag,
        refCanon(e.group),
        e.seq.toString(),
        e.changes.control?.toLowerCase() ?? null,
        e.changes.admission?.toLowerCase() ?? null,
        anchorCanon(e.changes.profile),
      ]);
    case 'dissolve':
      return JSON.stringify([e.tag, refCanon(e.group), e.seq.toString()]);
    case 'join':
      return JSON.stringify([e.tag, refCanon(e.group), e.member.kind, e.member.hash.toLowerCase()]);
    case 'resign':
      return JSON.stringify([e.tag, refCanon(e.group), e.key.toLowerCase()]);
    default:
      return JSON.stringify([e.tag, refCanon(e.join)]);
  }
}

/** Whether two key lists hold the same keys, in any order and case. */
export const sameSet = (a: string[], b: string[]): boolean => {
  const x = uniq(a);
  const y = uniq(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Binds a transaction to the action: the attached metadata is the one the body commits to, it
 * carries exactly one group payload and nothing else of governance or rewards, the required signers
 * are the selected signers, and every event and every published policy equals the expected payload.
 */
export function bindContent(
  facts: TxFacts,
  decoded: DecodedPayload | null,
  expected: PayloadInput,
  requiredSigners: string[],
  selected: string[],
): { ok: true } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!facts.auxHashMatches) return no('metadata does not match the transaction body');
  if (facts.groupPayloads !== 1) return no('transaction must carry exactly one group payload');
  if (facts.hasCertificates) return no('transaction carries certificates');
  if (facts.hasWithdrawals) return no('transaction carries withdrawals');
  if (facts.hasVotes) return no('transaction carries votes');
  if (facts.hasProposals) return no('transaction carries proposals');
  if (!sameSet(requiredSigners, selected)) return no('required signers differ from the selected signers');
  if (decoded === null) return no('group payload is not readable');
  if (decoded.events.length !== expected.events.length) return no('number of events differs from the action');
  for (let i = 0; i < expected.events.length; i++) {
    const d = decoded.events[i];
    if (!d.ok) return no(`event ${i + 1} is not readable`);
    if (eventCanon(d.event) !== eventCanon(expected.events[i])) return no(`event ${i + 1} differs from the action`);
  }
  if (!sameSet(decoded.scripts.map((s) => s.hash), (expected.scripts ?? []).map(hashOf)) || decoded.scripts.length !== (expected.scripts ?? []).length) {
    return no('published policies differ from the action');
  }
  return { ok: true };
}

/** The members and the profile change that the words of a change need beyond the events themselves. */
export interface DescribeOpts {
  joinMembers?: ReadonlyMap<string, Credential>;
  profile?: GroupChanges['profile'];
}

const viewOf = (s: NativeScript | null | undefined): ScriptView | null => (s ? scriptFromJson(scriptDisplayJson(s)) : null);

/**
 * The changes of a transaction's events. Policies come from the transaction's scripts or the
 * current state, which is the state before the transaction. Approved, removed and leaving members
 * are found by their join reference in `joinMembers`, a local join by its event.
 */
export function changesOfEvents(
  events: GroupEvent[],
  state: GroupState | null,
  scripts: ReadonlyArray<{ hash: string; script: NativeScript }> = [],
  o: DescribeOpts = {},
): GroupChanges {
  const policy = (hash: string): ScriptView | null =>
    viewOf(
      scripts.find((x) => x.hash === hash)?.script ??
        (state?.control.hash === hash ? state.control : state?.admission?.hash === hash ? state.admission : null),
    );
  const create = events.find((e) => e.tag === 'create');
  const c = noChanges(create?.tag === 'create' ? create.mode : (state?.mode ?? null));
  const joined = (r: RefLike): Credential | null => {
    if ('local' in r) {
      const e = events[r.local];
      return e?.tag === 'join' ? e.member : null;
    }
    return o.joinMembers?.get(refKey(r)) ?? null;
  };
  for (const e of events) {
    switch (e.tag) {
      case 'create':
        c.create = {
          control: policy(e.control),
          admission: e.admission === null ? null : e.admission === e.control ? 'same' : policy(e.admission),
        };
        break;
      case 'update': {
        const ch = e.changes;
        if (ch.control !== undefined) c.control = { before: viewOf(state?.control), after: policy(ch.control) };
        if (ch.admission !== undefined) {
          c.admission = ch.admission === ch.control ? 'same' : { before: viewOf(state?.admission), after: policy(ch.admission) };
        }
        if (ch.profile !== undefined) c.profile = o.profile ?? { before: null, after: null };
        break;
      }
      case 'dissolve':
        c.dissolve = true;
        break;
      case 'join':
        c.joins.push(e.member);
        break;
      case 'approve':
        c.approvals.push(joined(e.join));
        break;
      case 'leave':
        c.leaves.push(joined(e.join));
        break;
      case 'remove':
        c.removals.push(joined(e.join));
        break;
      case 'resign':
        c.resigned = e.key.toLowerCase();
        break;
    }
  }
  return c;
}

/**
 * The changes an intent asks for, for the draft of an action before it is built. Members of the
 * joins it approves, removes or leaves come from `joinMembers` by join reference, the profile
 * before and after from the form that changed it.
 */
export function changesOfIntent(
  intent: GroupIntent,
  state: GroupState | null,
  o: DescribeOpts = {},
): GroupChanges {
  const member = (j: string): Credential | null => o.joinMembers?.get(j.toLowerCase()) ?? null;
  const cred = (id: string): Credential | null => {
    const c = credentialForDrepId(id);
    return c ? { kind: c.kind, hash: c.hash.toLowerCase() } : null;
  };
  const c = noChanges(intent.kind === 'group_create' ? intent.mode : (state?.mode ?? null));
  switch (intent.kind) {
    case 'group_create': {
      const p = createPolicies(intent);
      c.create = { control: viewOf(p.control), admission: intent.admission === 'same' ? 'same' : viewOf(p.admission) };
      c.joins = intent.founders.map(cred);
      break;
    }
    case 'group_join':
      c.joins = [cred(intent.member)];
      break;
    case 'group_leave':
      c.leaves = [cred(intent.member)];
      break;
    case 'group_approve':
      c.approvals = intent.joins.map(member);
      break;
    case 'group_remove':
      c.removals = intent.joins.map(member);
      break;
    case 'group_update': {
      c.approvals = intent.approvals.map(member);
      if (intent.control) c.control = { before: viewOf(state?.control), after: viewOf(majority(intent.control)) };
      if (intent.admission === 'same' && intent.control) c.admission = 'same';
      else if (intent.admission && intent.admission !== 'same') c.admission = { before: viewOf(state?.admission), after: viewOf(majority(intent.admission)) };
      if (intent.profile) c.profile = o.profile ?? { before: null, after: null };
      break;
    }
    case 'group_dissolve':
      c.dissolve = true;
      break;
    case 'group_resign':
      c.resigned = intent.key.toLowerCase();
      break;
  }
  return c;
}

/** The ratio of the current policy carried to a new key count, rounded up. */
export function carryThreshold(kNew: number, nCur: number, kCur: number): number {
  return Math.ceil((kNew * nCur) / kCur);
}

export function moreThanHalf(k: number): number {
  return Math.floor(k / 2) + 1;
}

/** n and k of a policy: n of k for nOfK, all for all, one for any and a single key. */
export function thresholdOf(s: NativeScript): { n: number; k: number } {
  switch (s.type) {
    case 'nOfK':
      return { n: Number(s.n), k: s.scripts.length };
    case 'all':
      return { n: s.scripts.length, k: s.scripts.length };
    case 'any':
      return { n: 1, k: s.scripts.length };
    default:
      return { n: 1, k: 1 };
  }
}

/** Key hashes of the key DReps among the DRep ids, script DReps left out. */
function keyMembers(drepIds: string[]): string[] {
  return uniq(drepIds.flatMap((id) => {
    const c = credentialForDrepId(id);
    return c?.kind === 'key' ? [c.hash] : [];
  }));
}

function proposal(state: GroupState, keys: string[]): { keys: string[]; n: number; sameAdmission: boolean } {
  const { n, k } = thresholdOf(state.control);
  return { keys, n: carryThreshold(keys.length, n, k), sameAdmission: state.admission?.hash === state.control.hash };
}

/**
 * The control policy offered with an admission: current control keys whose DRep is still an
 * active member, plus every approved member, at the carried ratio. Members are DRep ids.
 */
export function proposeUpdate(state: GroupState, activeKeyMembers: string[], approved: string[]): { keys: string[]; n: number; sameAdmission: boolean } {
  const active = new Set(keyMembers(activeKeyMembers));
  const kept = collectKeyHashes(state.control).filter((k) => active.has(k.toLowerCase()));
  return proposal(state, uniq([...kept, ...keyMembers(approved)]));
}

/** The control policy offered when the policy keys drifted from the members: every active key member. */
export function proposeDrift(state: GroupState, activeKeyMembers: string[]): { keys: string[]; n: number; sameAdmission: boolean } {
  return proposal(state, keyMembers(activeKeyMembers));
}
