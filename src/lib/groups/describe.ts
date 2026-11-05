// Plain words for what a DRep group change does, in one place for the group history, the draft of
// an action, the signing page and the notifications. Pure: the callers read the names, policies
// and profiles, these functions only word them. DReps are named by their DRep name, else by their
// short DRep id, never by a join reference.
import type { Credential } from 'drep-groups';
import { drepIdForCredential } from './ids.js';
import { describePolicy, type ScriptView, shortHash } from './view.js';

/** Names by lowercase credential hash. */
export type Names = ReadonlyMap<string, string>;

/** A DRep's name, else its short DRep id. */
export function drepLabel(c: Credential, names: Names): string {
  return names.get(c.hash.toLowerCase()) ?? shortHash(drepIdForCredential(c));
}

/** The label of a key DRep by its key hash. */
export const keyLabel = (hash: string, names: Names): string => drepLabel({ kind: 'key', hash }, names);

/** "A", "A and B", "A, B and C". */
export function wordList(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** A flat policy over keys: n of the keys must sign. */
export interface PolicyShape {
  n: number;
  keys: string[];
}

/** n and the keys of a flat policy over keys, null for a nested or time locked one. */
export function policyShape(s: ScriptView | null): PolicyShape | null {
  if (!s) return null;
  if (s.kind === 'sig') return { n: 1, keys: [s.keyHash.toLowerCase()] };
  if (s.kind !== 'all' && s.kind !== 'any' && s.kind !== 'nOfK') return null;
  const keys: string[] = [];
  for (const c of s.children) {
    if (c.kind !== 'sig') return null;
    keys.push(c.keyHash.toLowerCase());
  }
  const n = s.kind === 'nOfK' ? Number(s.n) : s.kind === 'all' ? keys.length : 1;
  return Number.isInteger(n) ? { n, keys } : null;
}

/** Which policy a change is about. Both: the admission policy is the management policy. */
export type PolicyRole = 'control' | 'admission' | 'both';

const POLICY_LABEL: Record<PolicyRole, string> = {
  control: 'Management policy',
  admission: 'Admission policy',
  both: 'Management and admission policy',
};

const ratio = (p: PolicyShape): string => `${p.n} of ${p.keys.length}`;

/** A policy as its threshold and its keys by name, the nested ones in full. */
export function policyWords(s: ScriptView | null, names: Names): string {
  const p = policyShape(s);
  if (!p) return describePolicy(s, new Map(names));
  return `${ratio(p)}: ${wordList(p.keys.map((k) => keyLabel(k, names)))}`;
}

/**
 * What a policy change does, e.g. "Management policy changed from 3 of 4 to 2 of 3. Removed: X.
 * Added: Y." A policy without an earlier one is set, a nested one is described in full. With
 * `pending` the change is still to be signed and is worded as one that will happen.
 */
export function describePolicyChange(
  role: PolicyRole,
  before: ScriptView | null,
  after: ScriptView | null,
  names: Names,
  o: { pending?: boolean } = {},
): string {
  const label = POLICY_LABEL[role];
  const changed = o.pending ? 'changes' : 'changed';
  if (!after) return `${label} ${changed}.`;
  const a = policyShape(before);
  const b = policyShape(after);
  if (!before) return `${label} ${o.pending ? 'is set' : 'set'} to ${policyWords(after, names)}.`;
  if (!a || !b) return `${label} ${changed} to ${policyWords(after, names)}.`;
  const removed = a.keys.filter((k) => !b.keys.includes(k));
  const added = b.keys.filter((k) => !a.keys.includes(k));
  const sameRatio = a.n === b.n && a.keys.length === b.keys.length;
  if (sameRatio && removed.length === 0 && added.length === 0) return `${label} unchanged, ${ratio(b)}.`;
  const parts = [sameRatio ? `${label} stays ${ratio(b)}.` : `${label} ${changed} from ${ratio(a)} to ${ratio(b)}.`];
  if (removed.length > 0) parts.push(`Removed: ${wordList(removed.map((k) => keyLabel(k, names)))}.`);
  if (added.length > 0) parts.push(`Added: ${wordList(added.map((k) => keyLabel(k, names)))}.`);
  return parts.join(' ');
}

/** The profile fields a group document carries, missing ones as null or absent. */
export interface ProfileFields {
  name?: string | null;
  description?: string | null;
  website?: string | null;
  charter?: string | null;
  image?: string | null;
}

export const PROFILE_FIELDS = ['name', 'description', 'website', 'charter', 'image'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];
// Short text fields are worded with their new value, the others only by name.
const SHORT_FIELDS: ReadonlySet<ProfileField> = new Set(['name', 'website', 'charter']);

const fieldValue = (p: ProfileFields, f: ProfileField): string => (p[f] ?? '').trim();

const docText = (v: unknown): string | null => {
  const x = v && typeof v === 'object' && '@value' in v ? (v as { '@value': unknown })['@value'] : v;
  return typeof x === 'string' ? x : null;
};

/** The profile fields of a group profile document's JSON, null when it does not parse. */
export function profileFieldsOfDoc(json: string | null): ProfileFields | null {
  if (!json) return null;
  try {
    const doc = JSON.parse(json) as { body?: Record<string, unknown> } | null;
    const b = doc?.body && typeof doc.body === 'object' ? doc.body : null;
    if (!b) return null;
    return Object.fromEntries(PROFILE_FIELDS.map((f) => [f, docText(b[f])])) as ProfileFields;
  } catch {
    return null;
  }
}

/** The profile fields whose value differs. */
export function changedProfileFields(before: ProfileFields, after: ProfileFields): ProfileField[] {
  return PROFILE_FIELDS.filter((f) => fieldValue(before, f) !== fieldValue(after, f));
}

/**
 * What a profile change does, e.g. "Profile updated: name, image". With `values` the short text
 * fields carry their new value. Without both documents only the update itself is known.
 */
export function describeProfileChange(
  before: ProfileFields | null,
  after: ProfileFields | null,
  o: { values?: boolean; pending?: boolean } = {},
): string {
  const lead = o.pending ? 'Profile changes' : 'Profile updated';
  if (!before || !after) {
    const name = after ? fieldValue(after, 'name') : '';
    return o.values && name !== '' ? `${lead}, named "${name}".` : `${lead}.`;
  }
  const changed = changedProfileFields(before, after);
  if (changed.length === 0) return o.pending ? 'Profile stays the same.' : 'Profile unchanged.';
  const word = (f: ProfileField): string => {
    if (!o.values || !SHORT_FIELDS.has(f)) return f;
    const v = fieldValue(after, f);
    if (v === '') return `${f} removed`;
    return f === 'name' ? `name to "${v}"` : `${f} to ${v}`;
  };
  return `${lead}: ${changed.map(word).join(', ')}.`;
}

/** A credential, or null for a request the store no longer holds. */
export type Member = Credential | null;

/** The changes of one transaction, as the group history and an action description word them. */
export interface GroupChanges {
  mode: 'open' | 'permissioned' | null;
  /** The founding, with its policies. An admission equal to the control policy is 'same'. */
  create: { control: ScriptView | null; admission: ScriptView | null | 'same' } | null;
  joins: Member[];
  approvals: Member[];
  leaves: Member[];
  removals: Member[];
  /** A policy change with the policy before and after. Admission 'same' follows the control policy. */
  control: { before: ScriptView | null; after: ScriptView | null } | null;
  admission: { before: ScriptView | null; after: ScriptView | null } | 'same' | null;
  profile: { before: ProfileFields | null; after: ProfileFields | null } | null;
  dissolve: boolean;
}

export const noChanges = (mode: GroupChanges['mode'] = null): GroupChanges => ({
  mode,
  create: null,
  joins: [],
  approvals: [],
  leaves: [],
  removals: [],
  control: null,
  admission: null,
  profile: null,
  dissolve: false,
});

const memberLabel = (m: Member, names: Names): string => (m ? drepLabel(m, names) : 'a request that is no longer stored');
const members = (ms: Member[], names: Names): string => wordList(ms.map((m) => memberLabel(m, names)));

/** The sentences of the policy and profile changes. A pending action carries the new values. */
function settingSentences(c: GroupChanges, names: Names, pending: boolean): string[] {
  const out: string[] = [];
  if (c.control) out.push(describePolicyChange(c.admission === 'same' ? 'both' : 'control', c.control.before, c.control.after, names, { pending }));
  if (c.admission && c.admission !== 'same') out.push(describePolicyChange('admission', c.admission.before, c.admission.after, names, { pending }));
  if (c.profile) out.push(describeProfileChange(c.profile.before, c.profile.after, { values: pending, pending }));
  return out;
}

/** The founders of a founding: the members that join in the founding transaction. */
const foundersOf = (c: GroupChanges): Member[] => c.joins;

/** The founding in words, with its policies. */
function foundingLine(c: GroupChanges, names: Names, lead: string): string {
  const create = c.create;
  if (!create) return lead;
  const managed = `managed by ${policyWords(create.control, names)}`;
  const admission =
    create.admission === 'same' || create.admission === null ? '' : `, admission by ${policyWords(create.admission, names)}`;
  return `${lead}, ${managed}${admission}.`;
}

/**
 * One line per change of an action that is still to be signed, the wording of the draft, the
 * signing page and the signature request.
 */
export function describeAction(c: GroupChanges, names: Names): string[] {
  const lines: string[] = [];
  if (c.create) {
    const kind = c.mode === 'open' ? 'an open' : 'a permissioned';
    const founders = foundersOf(c);
    const lead = founders.length > 0 ? `Found ${kind} group with ${members(founders, names)} as founders` : `Found ${kind} group`;
    lines.push(foundingLine(c, names, lead));
  } else {
    if (c.joins.length > 0) {
      lines.push(c.mode === 'permissioned' ? `${members(c.joins, names)} requests to join the group.` : `${members(c.joins, names)} joins the group.`);
    }
    if (c.approvals.length > 0) lines.push(`Approve ${members(c.approvals, names)} as ${c.approvals.length === 1 ? 'a member' : 'members'}.`);
    if (c.removals.length > 0) lines.push(`Remove ${members(c.removals, names)} from the group.`);
    if (c.leaves.length > 0) lines.push(`${members(c.leaves, names)} leaves the group.`);
  }
  lines.push(...settingSentences(c, names, true));
  if (c.dissolve) lines.push('Dissolve the group. Every membership ends.');
  if (lines.length === 0) lines.push('Confirm the group settings without changes.');
  return lines;
}

/** The marker of a history entry, the icon it shows. */
export type HistoryKind = 'founded' | 'joined' | 'requested' | 'approved' | 'left' | 'removed' | 'policy' | 'profile' | 'dissolved';

/**
 * One history entry for the changes of one confirmed transaction, e.g. "Carol joined, approved by
 * Alice and Bob." with the policy and profile sentences after it. `signers` are the policy keys
 * that signed the transaction.
 */
export function describeHistory(c: GroupChanges, signers: string[], names: Names): { kind: HistoryKind; text: string } {
  const by = signers.length > 0 ? ` by ${wordList(signers.map((k) => keyLabel(k, names)))}` : '';
  const settings = settingSentences(c, names, false);
  const withSettings = (kind: HistoryKind, lead: string) => ({ kind, text: [lead, ...settings].join(' ') });
  if (c.create) {
    const founders = foundersOf(c);
    const lead = founders.length > 0 ? `Group founded by ${members(founders, names)}` : 'Group founded';
    return { kind: 'founded', text: foundingLine(c, names, lead) };
  }
  if (c.dissolve) return withSettings('dissolved', `Group dissolved${by}.`);
  const sentences: string[] = [];
  let kind: HistoryKind | null = null;
  const note = (k: HistoryKind, s: string) => {
    kind ??= k;
    sentences.push(s);
  };
  // Joins approved in the same transaction read as one entry.
  const approvedJoin = c.joins.filter((j) => j && c.approvals.some((a) => a && a.hash === j.hash && a.kind === j.kind));
  const otherJoins = c.joins.filter((j) => !approvedJoin.includes(j));
  if (c.approvals.length > 0) note('approved', `${members(c.approvals, names)} joined, approved${by}.`);
  if (otherJoins.length > 0) {
    note(c.mode === 'permissioned' ? 'requested' : 'joined', c.mode === 'permissioned' ? `${members(otherJoins, names)} requested to join.` : `${members(otherJoins, names)} joined.`);
  }
  if (c.removals.length > 0) note('removed', `${members(c.removals, names)} removed${by}.`);
  if (c.leaves.length > 0) note('left', `${members(c.leaves, names)} left.`);
  if (kind === null) {
    // A settings only update names its signers after the change.
    const k: HistoryKind = c.control || c.admission ? 'policy' : 'profile';
    const text = settings.length > 0 ? settings.join(' ') : 'Group settings confirmed without changes.';
    return { kind: k, text: by ? `${text} Signed${by}.` : text };
  }
  return { kind, text: [...sentences, ...settings].join(' ') };
}
