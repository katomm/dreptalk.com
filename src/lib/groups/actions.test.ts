import {
  type Credential,
  decodePayload,
  EncodeError,
  type EventRef,
  type GroupEvent,
  majorityScript,
  type NativeScript,
  type PayloadInput,
  refKey,
  type TxFacts,
  encodePayload,
} from 'drep-groups';
import { describe, expect, it } from 'vitest';
import {
  bindContent,
  carryThreshold,
  changesOfEvents,
  changesOfIntent,
  expectedPayload,
  type GroupIntent,
  type GroupState,
  mayInitiate,
  maySign,
  moreThanHalf,
  neededKeys,
  neededPolicyKeys,
  neededPolicies,
  proposeDrift,
  proposeUpdate,
  signerSetSatisfies,
} from './actions.js';
import { describeAction } from './describe.js';
import { drepIdForCredential, groupIdString } from './ids.js';

const K = (n: number): string => n.toString(16).padStart(56, '0');
const T = (n: number): string => n.toString(16).padStart(64, '0');
const keyId = (n: number): string => drepIdForCredential({ kind: 'key', hash: K(n) });
const scriptId = (n: number): string => drepIdForCredential({ kind: 'script', hash: K(n) });
const [ALICE, BOB, CAROL, DAVE, ERIN, OUTSIDER] = [1, 2, 3, 4, 5, 9];
const GROUP: EventRef = { txHash: T(10), index: 0 };
const GID = groupIdString(GROUP);
const CAROL_JOIN = `${T(50)}#0`;
const ANCHOR = { url: 'https://example.org/group.jsonld', dataHash: 'ab'.repeat(32) };

const policy = (keys: number[], n: number): GroupState['control'] => {
  const s = majorityScript(keys.map(K), n);
  return Object.assign(s.script, { hash: s.hash });
};

function state(o: { mode?: GroupState['mode']; control?: GroupState['control']; admission?: GroupState['admission'] | 'same' } = {}): GroupState {
  const control = o.control ?? policy([ALICE, BOB, DAVE, ERIN], 3);
  const admission = o.admission === 'same' || o.admission === undefined ? control : o.admission;
  return { ref: GROUP, mode: o.mode ?? 'permissioned', status: 'active', seq: 4n, control, admission };
}

const tags = (p: PayloadInput): string[] => p.events.map((e) => e.tag);
const cleanFacts: TxFacts = {
  auxDataHash: 'cd'.repeat(32),
  auxHashMatches: true,
  hasCertificates: false,
  hasWithdrawals: false,
  hasVotes: false,
  hasProposals: false,
  groupPayloads: 1,
};
const decode = (p: PayloadInput) => decodePayload(encodePayload(p));
const joins = new Map<string, Credential>([[CAROL_JOIN, { kind: 'key', hash: K(CAROL) }]]);

const jointCreate: GroupIntent = {
  kind: 'group_create',
  mode: 'permissioned',
  control: { keys: [K(ALICE), K(BOB), K(CAROL)], n: 2 },
  admission: 'same',
  founders: [keyId(ALICE), keyId(BOB), keyId(CAROL)],
  profile: null,
};

const combined: GroupIntent = {
  kind: 'group_update',
  group: GID,
  approvals: [CAROL_JOIN],
  control: { keys: [ALICE, BOB, CAROL, DAVE, ERIN].map(K), n: 4 },
};

describe('expectedPayload', () => {
  it('orders a joint permissioned create as create, joins, approvals', () => {
    const p = expectedPayload(jointCreate, null, new Map());
    expect(tags(p)).toEqual(['create', 'join', 'join', 'join', 'approve', 'approve', 'approve']);
    expect(p.events.slice(1, 4).map((e) => (e as Extract<GroupEvent, { tag: 'join' }>).group)).toEqual([{ local: 0 }, { local: 0 }, { local: 0 }]);
    expect(p.events.slice(4).map((e) => (e as Extract<GroupEvent, { join: unknown }>).join)).toEqual([{ local: 1 }, { local: 2 }, { local: 3 }]);
    const create = p.events[0] as Extract<GroupEvent, { tag: 'create' }>;
    expect(create.admission).toBe(create.control);
    expect(p.scripts).toHaveLength(1);
  });

  it('orders a combined admission as approvals first and the update last', () => {
    const p = expectedPayload(combined, state({ admission: policy([ALICE, BOB], 1) }), joins);
    expect(tags(p)).toEqual(['approve', 'update']);
    const update = p.events[1] as Extract<GroupEvent, { tag: 'update' }>;
    expect(update.seq).toBe(4n);
    expect(update.group).toEqual(GROUP);
    expect(update.changes.admission).toBeUndefined();
    expect(p.scripts).toHaveLength(1);
  });

  it('refuses a threshold of 0 and one above the key count', () => {
    const zero: GroupIntent = { ...jointCreate, control: { keys: [K(ALICE)], n: 0 } } as GroupIntent;
    const above: GroupIntent = { ...jointCreate, control: { keys: [K(ALICE)], n: 2 } } as GroupIntent;
    expect(() => expectedPayload(zero, null, new Map())).toThrow(EncodeError);
    expect(() => expectedPayload(above, null, new Map())).toThrow(EncodeError);
  });

  it('carries a shared admission policy into the proposed update', () => {
    const s = state({ control: policy([ALICE, BOB, DAVE, ERIN], 3), admission: 'same' });
    const offer = proposeUpdate(s, [ALICE, BOB, DAVE, ERIN].map(keyId), [keyId(CAROL)]);
    expect(offer.sameAdmission).toBe(true);
    const intent: GroupIntent = { ...combined, control: { keys: offer.keys, n: offer.n }, admission: 'same' } as GroupIntent;
    const p = expectedPayload(intent, s, joins);
    const update = p.events[1] as Extract<GroupEvent, { tag: 'update' }>;
    expect(update.changes.control).toBeDefined();
    expect(update.changes.admission).toBe(update.changes.control);
    expect(p.scripts).toHaveLength(1);
    expect(proposeUpdate(state({ admission: policy([ALICE], 1) }), [], []).sameAdmission).toBe(false);
  });
});

describe('policies, keys and initiators', () => {
  it('needs the admission and the control policy for a combined action', () => {
    const admission = policy([ALICE, BOB], 1);
    const s = state({ admission });
    const p = neededPolicies(combined, s, null);
    expect(p.control).toBe(s.control);
    expect(p.admission).toBe(admission);
    expect(neededPolicies({ ...combined, approvals: [] } as GroupIntent, s, null).admission).toBeNull();
    const signers = [K(ALICE), K(BOB), K(DAVE), K(CAROL)];
    const interval = { invalidBefore: null, invalidHereafter: 1000n };
    expect(signerSetSatisfies(s, combined, null, signers, interval)).toBe(true);
    // Without the admission key the approval fails, without Carol her consent to the new policy is missing.
    expect(signerSetSatisfies(s, combined, null, [K(DAVE), K(ERIN), K(CAROL)], interval)).toBe(false);
    expect(signerSetSatisfies(s, combined, null, [K(ALICE), K(BOB), K(DAVE)], interval)).toBe(false);
  });

  it('lets only a needed policy key initiate and a newly listed key only sign', () => {
    const s = state();
    const grab: GroupIntent = { kind: 'group_update', group: GID, approvals: [], control: { keys: [K(ALICE), K(OUTSIDER)], n: 1 } };
    expect(mayInitiate(grab, s, { keyHash: K(OUTSIDER), drepId: keyId(OUTSIDER) })).toBe(false);
    expect(neededKeys(grab, s, null).mandatory).toEqual([K(OUTSIDER)]);
    expect(mayInitiate(grab, s, { keyHash: K(ALICE), drepId: keyId(ALICE) })).toBe(true);
    expect(mayInitiate(jointCreate, null, { keyHash: K(BOB), drepId: keyId(BOB) })).toBe(true);
    expect(mayInitiate(jointCreate, null, { keyHash: K(DAVE), drepId: keyId(DAVE) })).toBe(false);
    const join: GroupIntent = { kind: 'group_join', group: GID, member: keyId(CAROL) };
    expect(mayInitiate(join, s, { keyHash: K(CAROL), drepId: keyId(CAROL) })).toBe(true);
    expect(mayInitiate(join, s, { keyHash: K(ALICE), drepId: keyId(ALICE) })).toBe(false);
    const dissolve: GroupIntent = { kind: 'group_dissolve', group: GID };
    expect(mayInitiate(dissolve, s, { keyHash: K(CAROL), drepId: keyId(CAROL) })).toBe(false);
    expect(mayInitiate(dissolve, s, { keyHash: null, drepId: scriptId(ALICE) })).toBe(false);
  });

  it('refuses an initiator for a dissolved group and for the state of another group', () => {
    const dissolve: GroupIntent = { kind: 'group_dissolve', group: GID };
    const alice = { keyHash: K(ALICE), drepId: keyId(ALICE) };
    expect(mayInitiate(dissolve, state(), alice)).toBe(true);
    expect(mayInitiate(dissolve, { ...state(), status: 'dissolved' }, alice)).toBe(false);
    expect(mayInitiate(dissolve, { ...state(), ref: { txHash: T(11), index: 0 } }, alice)).toBe(false);
  });

  it('lets every mandatory and optional key sign and a script DRep only its own join or leave', () => {
    const s = state({ admission: policy([ALICE, BOB], 1) });
    for (const n of [ALICE, BOB, CAROL, DAVE, ERIN]) expect(maySign(combined, s, null, { keyHash: K(n), drepId: keyId(n) })).toBe(true);
    expect(maySign(combined, s, null, { keyHash: K(OUTSIDER), drepId: keyId(OUTSIDER) })).toBe(false);
    expect(maySign(combined, s, null, { keyHash: null, drepId: scriptId(ALICE) })).toBe(false);
    const member: NativeScript = { type: 'sig', keyHash: K(7) };
    const scriptJoin: GroupIntent = { kind: 'group_join', group: GID, member: scriptId(8) };
    expect(maySign(scriptJoin, s, member, { keyHash: null, drepId: scriptId(8) })).toBe(true);
    expect(maySign(scriptJoin, s, member, { keyHash: K(7), drepId: keyId(7) })).toBe(false);
    expect(neededPolicyKeys(scriptJoin, s, member)).toEqual([K(7)]);
  });

  it('lists extra admission keys as signers without joining', () => {
    const intent: GroupIntent = {
      kind: 'group_create',
      mode: 'permissioned',
      control: { keys: [K(ALICE)], n: 1 },
      admission: { keys: [K(ALICE), K(OUTSIDER)], n: 1 },
      founders: [keyId(ALICE)],
      profile: ANCHOR,
    };
    const p = expectedPayload(intent, null, new Map());
    expect(tags(p)).toEqual(['create', 'join', 'approve']);
    expect(p.scripts).toHaveLength(2);
    expect(neededKeys(intent, null, null).mandatory).toEqual([K(ALICE), K(OUTSIDER)]);
    expect(mayInitiate(intent, null, { keyHash: K(OUTSIDER), drepId: keyId(OUTSIDER) })).toBe(false);
  });

  it('makes every new key mandatory for an update and every listed key for a create', () => {
    expect(neededKeys(jointCreate, null, null)).toEqual({ mandatory: [K(ALICE), K(BOB), K(CAROL)], optional: [] });
    const s = state({ admission: policy([ALICE, BOB], 1) });
    expect(neededKeys(combined, s, null)).toEqual({ mandatory: [K(CAROL)], optional: [ALICE, BOB, DAVE, ERIN].map(K) });
    const leave: GroupIntent = { kind: 'group_leave', group: GID, member: keyId(CAROL) };
    expect(neededKeys(leave, s, null)).toEqual({ mandatory: [K(CAROL)], optional: [] });
    const member: NativeScript = { type: 'all', scripts: [{ type: 'sig', keyHash: K(7) }, { type: 'after', slot: 100n }] };
    const scriptLeave: GroupIntent = { kind: 'group_leave', group: GID, member: scriptId(8), join: `${T(60)}#1` };
    expect(neededKeys(scriptLeave, s, member)).toEqual({ mandatory: [], optional: [K(7)] });
    expect(signerSetSatisfies(s, scriptLeave, member, [K(7)], { invalidBefore: 100n, invalidHereafter: null })).toBe(true);
    expect(signerSetSatisfies(s, scriptLeave, member, [K(7)], { invalidBefore: null, invalidHereafter: null })).toBe(false);
    expect(expectedPayload(scriptLeave, s, new Map()).events).toEqual([{ tag: 'leave', join: { txHash: T(60), index: 1 } }]);
    expect(expectedPayload(leave, s, joins).events).toEqual([{ tag: 'leave', join: { txHash: T(50), index: 0 } }]);
  });
});

describe('bindContent', () => {
  const s = state({ admission: policy([ALICE, BOB], 1) });
  const expected = expectedPayload({ ...combined, profile: ANCHOR } as GroupIntent, s, joins);
  const rs = [K(ALICE), K(CAROL)];
  const update = expected.events[1] as Extract<GroupEvent, { tag: 'update' }>;
  const approve = expected.events[0] as Extract<GroupEvent, { join: unknown }>;
  const other = majorityScript([K(ALICE), K(CAROL)], 1);
  const withEvents = (events: GroupEvent[], scripts = expected.scripts): PayloadInput => ({ events, scripts });

  it('accepts the expected payload', () => {
    expect(bindContent(cleanFacts, decode(expected), expected, rs, [...rs].reverse())).toEqual({ ok: true });
  });

  it('rejects a payload that differs in one field', () => {
    const variants: PayloadInput[] = [
      withEvents([{ tag: 'remove', join: approve.join }, update]),
      withEvents([approve, { ...update, group: { txHash: T(11), index: 0 } }]),
      withEvents([approve, { ...update, seq: 5n }]),
      withEvents([{ tag: 'approve', join: { txHash: T(51), index: 0 } }, update]),
      withEvents([approve, { ...update, changes: { ...update.changes, control: other.hash } }], [other.script]),
      withEvents([approve, { ...update, changes: { ...update.changes, profile: { ...ANCHOR, dataHash: 'ef'.repeat(32) } } }]),
      withEvents([approve, { ...update, changes: { ...update.changes, profile: { ...ANCHOR, url: 'https://example.org/other' } } }]),
      withEvents([approve, update], [...(expected.scripts ?? []), other.script]),
    ];
    for (const v of variants) {
      const r = bindContent(cleanFacts, decode(v), expected, rs, rs);
      expect(r.ok, JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))).toBe(false);
    }
    const join: GroupIntent = { kind: 'group_join', group: GID, member: keyId(CAROL) };
    const jp = expectedPayload(join, s, new Map());
    const otherMember = expectedPayload({ ...join, member: keyId(DAVE) }, s, new Map());
    expect(bindContent(cleanFacts, decode(otherMember), jp, [K(CAROL)], [K(CAROL)])).toEqual({ ok: false, reason: 'event 1 differs from the action' });
  });

  it('rejects an extra event, a wrong order and wrong required signers', () => {
    expect(bindContent(cleanFacts, decode(withEvents([approve, update, { tag: 'approve', join: { txHash: T(52), index: 0 } }])), expected, rs, rs).ok).toBe(false);
    expect(bindContent(cleanFacts, decode(withEvents([update, approve])), expected, rs, rs).ok).toBe(false);
    expect(bindContent(cleanFacts, decode(expected), expected, [K(ALICE)], rs)).toEqual({ ok: false, reason: 'required signers differ from the selected signers' });
    expect(bindContent(cleanFacts, null, expected, rs, rs)).toEqual({ ok: false, reason: 'group payload is not readable' });
    for (const f of ['hasCertificates', 'hasWithdrawals', 'hasVotes', 'hasProposals'] as const) {
      expect(bindContent({ ...cleanFacts, [f]: true }, decode(expected), expected, rs, rs).ok).toBe(false);
    }
    expect(bindContent({ ...cleanFacts, groupPayloads: 2 }, decode(expected), expected, rs, rs).ok).toBe(false);
  });

  it('rejects swapped auxiliary data', () => {
    expect(bindContent({ ...cleanFacts, auxHashMatches: false }, decode(expected), expected, rs, rs)).toEqual({
      ok: false,
      reason: 'metadata does not match the transaction body',
    });
  });
});

describe('proposals', () => {
  it('carries the threshold and offers more than half', () => {
    expect([carryThreshold(5, 3, 4), carryThreshold(6, 4, 5), carryThreshold(7, 5, 6)]).toEqual([4, 5, 6]);
    expect([moreThanHalf(4), moreThanHalf(5)]).toEqual([3, 3]);
  });

  it('proposes current admins who are still members plus the new member', () => {
    const s = state({ control: policy([ALICE, BOB, DAVE, ERIN], 3) });
    expect(proposeUpdate(s, [ALICE, BOB, DAVE, ERIN].map(keyId), [keyId(CAROL)])).toEqual({
      keys: [ALICE, BOB, CAROL, DAVE, ERIN].map(K),
      n: 4,
      sameAdmission: true,
    });
    // Erin left: her key is dropped, an earlier member who was never an admin stays out.
    expect(proposeUpdate(s, [ALICE, BOB, DAVE, 6].map(keyId), [keyId(CAROL)])).toEqual({
      keys: [ALICE, BOB, CAROL, DAVE].map(K),
      n: 3,
      sameAdmission: true,
    });
    expect(proposeDrift(s, [ALICE, BOB, DAVE, 6].map(keyId))).toEqual({ keys: [ALICE, BOB, DAVE, 6].map(K), n: 3, sameAdmission: true });
  });

  it('leaves script DRep members out of every proposal', () => {
    const s = state({ control: policy([ALICE, BOB], 2) });
    expect(proposeUpdate(s, [keyId(ALICE), keyId(BOB), scriptId(7)], [scriptId(8)]).keys).toEqual([K(ALICE), K(BOB)]);
    expect(proposeDrift(s, [keyId(ALICE), scriptId(7), keyId(CAROL)]).keys).toEqual([K(ALICE), K(CAROL)]);
  });
});

describe('describing the events of a transaction', () => {
  it('describes a combined action in plain words', () => {
    const s = state({ admission: policy([ALICE, BOB], 1) });
    const p = expectedPayload(combined, s, joins);
    const decoded = decode(p);
    if (!decoded) throw new Error('payload does not decode');
    const events = decoded.events.flatMap((e) => (e.ok ? [e.event] : []));
    const names = new Map([
      [K(ALICE), 'Alice'],
      [K(BOB), 'Bob'],
      [K(CAROL), 'Carol'],
      [K(DAVE), 'Dave'],
      [K(ERIN), 'Erin'],
    ]);
    const joinMembers = new Map([[refKey({ txHash: T(50), index: 0 }), { kind: 'key' as const, hash: K(CAROL) }]]);
    expect(describeAction(changesOfEvents(events, s, decoded.scripts, { joinMembers }), names)).toEqual([
      'Approve Carol as a member.',
      'Management policy changes from 3 of 4 to 4 of 5. Added: Carol.',
    ]);
  });

  it('names an approved member without a DRep name by the DRep id', () => {
    const s = state({ admission: policy([ALICE, BOB], 1) });
    const events: GroupEvent[] = [{ tag: 'approve', join: { txHash: T(50), index: 0 } }];
    const joinMembers = new Map([[refKey({ txHash: T(50), index: 0 }), { kind: 'key' as const, hash: K(CAROL) }]]);
    const [line] = describeAction(changesOfEvents(events, s, [], { joinMembers }), new Map());
    expect(line).toBe(`Approve ${keyId(CAROL).slice(0, 8)}...${keyId(CAROL).slice(-4)} as a member.`);
  });

  it('describes a joint create with its founders', () => {
    const p = expectedPayload(jointCreate, null, new Map());
    const names = new Map([
      [K(ALICE), 'Alice'],
      [K(BOB), 'Bob'],
      [K(CAROL), 'Carol'],
    ]);
    const scripts = (p.scripts ?? []).map((script) => ({ hash: (p.events[0] as Extract<GroupEvent, { tag: 'create' }>).control, script }));
    expect(describeAction(changesOfEvents(p.events, null, scripts), names)).toEqual([
      'Found a permissioned group with Alice, Bob and Carol as founders, managed by 2 of 3: Alice, Bob and Carol.',
    ]);
  });
});

describe('changesOfIntent', () => {
  const names = new Map([
    [K(ALICE), 'Alice'],
    [K(BOB), 'Bob'],
    [K(CAROL), 'Carol'],
    [K(DAVE), 'Dave'],
    [K(ERIN), 'Erin'],
  ]);
  const joinMembers = new Map([[CAROL_JOIN, { kind: 'key' as const, hash: K(CAROL) }]]);

  it('words a combined approval of a draft like the signing page', () => {
    const s = state();
    const intent: GroupIntent = {
      kind: 'group_update',
      group: GID,
      approvals: [CAROL_JOIN],
      control: { keys: [K(ALICE), K(BOB), K(CAROL), K(DAVE), K(ERIN)], n: 4 },
      admission: 'same',
    };
    expect(describeAction(changesOfIntent(intent, s, { joinMembers }), names)).toEqual([
      'Approve Carol as a member.',
      'Management and admission policy changes from 3 of 4 to 4 of 5. Added: Carol.',
    ]);
  });

  it('words removals, profile changes and a dissolution of a draft', () => {
    const s = state();
    expect(describeAction(changesOfIntent({ kind: 'group_remove', group: GID, joins: [CAROL_JOIN] }, s, { joinMembers }), names)).toEqual([
      'Remove Carol from the group.',
    ]);
    const profile = { before: { name: 'Old' }, after: { name: 'New' } };
    expect(describeAction(changesOfIntent({ kind: 'group_update', group: GID, approvals: [], profile: ANCHOR }, s, { profile }), names)).toEqual([
      'Profile changes: name to "New".',
    ]);
    expect(describeAction(changesOfIntent({ kind: 'group_dissolve', group: GID }, s), names)).toEqual(['Dissolve the group. Every membership ends.']);
  });

  it('words a founding with its founders', () => {
    expect(describeAction(changesOfIntent(jointCreate, null), names)).toEqual([
      'Found a permissioned group with Alice, Bob and Carol as founders, managed by 2 of 3: Alice, Bob and Carol.',
    ]);
  });
});
