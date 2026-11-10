/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import {
  getGroup,
  groupActionState,
  listListedGroups,
  listedGroupFaces,
  topListedPower,
  listMembers,
  listVerdicts,
  scriptDisplays,
  treasuryScripts,
  UNRESOLVED_FOR_DREP_SQL,
  unresolvedGroupActionsForDrep,
} from '../../../lib/db/drepGroups.js';
import { planOf } from '../../../lib/groups/__tests__/queryPlan.js';
import { createGroupAction, type NewGroupAction, openControlAction } from '../../../lib/groups/actionStore.js';
import { type GroupIntent, parseJoinRef } from '../../../lib/groups/actions.js';
import { wallClockSlot } from '../../../lib/groups/groupTx.js';
import { groupIdForms, groupIdParam, groupIdString } from '../../../lib/groups/ids.js';
import { GET as stateRoute } from '../../api/groups/[id]/state.js';
import { ALICE, BOB, CAROL, call, DAVE, groupTx, PERM, seed, seedPermissioned, sessionOf } from '../../api/groups/actions/__tests__/fixtures.js';
import seedSql from './twoMemberGroup.sql?raw';

const db = env.DB as D1Database;

vi.mock('@/lib/api/response', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/response')>()),
  currentNetwork: () => ({ network: 'preprod', koiosBaseUrl: 'https://koios.invalid/api/v1' }),
}));
const SEEDED = 'drep_group17rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rcqqdh4wag';
const SEEDED_LEGACY = 'group17rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rcqqqqwf5cvh';
// The 34 byte `drep_group1` form the ids had before the one byte index.
const SEEDED_TWO_BYTE = 'drep_group17rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rcqqqqc6m8ss';
const PERM_ID = groupIdString(PERM.ref);
const OTHER_ID = groupIdString({ txHash: 'cd'.repeat(32), index: 0 });

async function seedTwoMemberGroup(): Promise<void> {
  const statements = seedSql
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.batch(statements.map((s) => db.prepare(s)));
}

describe('group detail lookup', () => {
  it('finds nothing for an unknown or malformed group id', async () => {
    expect(groupIdParam('garbage')).toBeNull();
    expect(groupIdParam('group1qqq')).toBeNull();
    expect(await getGroup(db, 'group1qqq')).toBeNull();
    const id = groupIdString({ txHash: 'ab'.repeat(32), index: 0 });
    expect(groupIdParam(id.toUpperCase())).toEqual({ txHash: 'ab'.repeat(32), index: 0 });
    expect(await getGroup(db, id)).toBeNull();
  });

  it('reads the local seed as a listed group with two members', async () => {
    await seedTwoMemberGroup();
    const group = await getGroup(db, SEEDED.toUpperCase());
    expect(group?.groupId).toBe(SEEDED);
    expect((await getGroup(db, SEEDED_LEGACY))?.groupId).toBe(SEEDED);
    // The group page answers a 301 to the canonical URL whenever the read id differs from the requested one.
    expect((await getGroup(db, SEEDED_TWO_BYTE))?.groupId).toBe(SEEDED);
    expect(group?.members).toBe(2);
    expect(group?.profile?.name).toBe('Example Council');
    const listed = await listListedGroups(db, null, 50);
    expect(listed.map((g) => g.groupId)).toEqual([SEEDED]);
    const ref = group?.ref ?? { txHash: '', index: 0 };
    // The list rows show the first members by join position, read in one batch.
    const faces = await listedGroupFaces(db, [ref, { txHash: 'ab'.repeat(32), index: 0 }]);
    expect([...faces.keys()]).toEqual([SEEDED]);
    expect(faces.get(SEEDED)?.map((f) => f.name)).toEqual(['Alice Example', 'Bob Example']);
    expect(await topListedPower(db)).toBe(listed[0].memberPower);
    // Seeding again keeps the listing count, the seed takes it again from the stored leads.
    await seedTwoMemberGroup();
    expect((await listListedGroups(db, null, 50)).map((g) => g.groupId)).toEqual([SEEDED]);
    const members = await listMembers(db, ref, 'active', null, 50);
    expect(members.map((m) => m.drepName)).toEqual(['Alice Example', 'Bob Example']);
    expect((await listVerdicts(db, ref, true, 200)).map((v) => v.tag)).toEqual(['join', 'join', 'create']);
    const treasury = 'c3'.repeat(28);
    expect((await scriptDisplays(db, [group?.controlHash ?? '', treasury])).size).toBe(2);
    const read = await treasuryScripts(db, [treasury, 'ee'.repeat(28)]);
    expect([...read.scripts.keys()]).toEqual([treasury]);
    expect([...read.displays.keys()]).toEqual([treasury]);
  });
});

describe('group action readers', () => {
  const rec = (id: string, o: Partial<NewGroupAction> = {}): NewGroupAction => ({
    id,
    kind: 'group_approve',
    subjectKind: 'group',
    subjectId: PERM_ID,
    intent: { kind: 'group_approve', group: PERM_ID, joins: [PERM.carolJoin] },
    nativeScriptJson: '{}',
    unsignedTxCbor: '84',
    bodyHash: id.padEnd(64, '0'),
    requiredSigners: [BOB.hash],
    invalidHereafter: 500,
    feeInputs: [{ txHash: 'ef'.repeat(32), index: 1 }],
    feePayKeys: ['12'.repeat(28)],
    eventCount: 1,
    controlSlot: false,
    profileHash: null,
    createdBy: 'u-bob',
    now: 1000,
    ...o,
  });

  it('gives the group page the open control action, unresolved rows, the viewer rows, members and policy keys', async () => {
    await seedPermissioned();
    // The create of the seeded group carries the group id from the start and is still unresolved.
    const create: GroupIntent = {
      kind: 'group_create',
      mode: 'permissioned',
      control: { keys: [ALICE.hash], n: 1 },
      admission: { keys: [BOB.hash], n: 1 },
      founders: [ALICE.drepId],
      profile: null,
    };
    await createGroupAction(db, rec('c1', { kind: 'group_create', intent: create, bodyHash: PERM.ref.txHash, requiredSigners: [ALICE.hash, BOB.hash] }));
    await db.prepare("UPDATE pending_multisig_tx SET status = 'submitted' WHERE id = 'c1'").run();
    await createGroupAction(db, rec('u1', { kind: 'group_update', intent: { kind: 'group_update', group: PERM_ID, approvals: [] }, controlSlot: true, requiredSigners: [ALICE.hash] }));
    await createGroupAction(db, rec('a1'));
    await createGroupAction(db, rec('done'));
    await db.prepare("UPDATE pending_multisig_tx SET resolved_at = 5, resolution = 'applied' WHERE id = 'done'").run();
    // Carol's own leave in this group, and one in another group that the page leaves out.
    const leave = (group: string): GroupIntent => ({ kind: 'group_leave', group, member: CAROL.drepId, join: PERM.carolJoin });
    await createGroupAction(db, rec('l1', { kind: 'group_leave', subjectKind: 'member', subjectId: CAROL.drepId, intent: leave(PERM_ID), requiredSigners: [CAROL.hash] }));
    await createGroupAction(db, rec('l2', { kind: 'group_leave', subjectKind: 'member', subjectId: CAROL.drepId, intent: leave(OTHER_ID), requiredSigners: [CAROL.hash] }));

    const group = await getGroup(db, PERM_ID);
    if (!group) throw new Error('seeded group missing');
    const s = await groupActionState(db, group, { drepId: CAROL.drepId });
    expect(s.openControl?.id).toBe('u1');
    expect(s.rows.map((r) => r.id).sort()).toEqual(['a1', 'c1', 'u1']);
    const c1 = s.rows.find((r) => r.id === 'c1');
    expect(c1).toMatchObject({ kind: 'group_create', status: 'submitted', groupId: PERM_ID, requiredSigners: [ALICE.hash, BOB.hash] });
    expect(s.viewerRows.map((r) => r.id)).toEqual(['l1']);
    expect(s.viewerJoin).toEqual({ joinId: PERM.carolJoin, state: 'pending' });
    expect(s.pending.map((m) => m.drepId)).toEqual([CAROL.drepId]);
    expect(s.activeKeyMembers).toEqual([]);
    expect(s.control.keys).toEqual([ALICE.hash]);
    expect(s.admission?.keys).toEqual([BOB.hash]);
    expect(s.control.hash).toBe(PERM.control.hash);

    // A second founder sees the confirming joint create on the group page too, Dave has no own rows.
    const bob = await groupActionState(db, group, { drepId: BOB.drepId });
    expect(bob.rows.some((r) => r.id === 'c1' && r.status === 'submitted')).toBe(true);
    expect(bob.viewerJoin).toBeNull();
    const dave = await groupActionState(db, group, { drepId: DAVE.drepId });
    expect(dave.viewerRows).toEqual([]);
  });

  it('lists the unresolved group rows of a DRep: its member rows and the rows that need its key', async () => {
    await seedPermissioned();
    // A joint create of a group that does not exist yet, Bob is its second founder.
    const body = 'ab'.repeat(32);
    const newId = groupIdString({ txHash: body, index: 0 });
    const create: GroupIntent = {
      kind: 'group_create',
      mode: 'open',
      control: { keys: [ALICE.hash, BOB.hash], n: 2 },
      admission: null,
      founders: [ALICE.drepId, BOB.drepId],
      profile: null,
    };
    await createGroupAction(db, rec('c2', { kind: 'group_create', intent: create, subjectId: newId, bodyHash: body, requiredSigners: [ALICE.hash, BOB.hash], createdBy: 'u-alice' }));
    const join: GroupIntent = { kind: 'group_join', group: PERM_ID, member: CAROL.drepId };
    await createGroupAction(db, rec('j1', { kind: 'group_join', subjectKind: 'member', subjectId: CAROL.drepId, intent: join, requiredSigners: [CAROL.hash] }));
    await createGroupAction(db, rec('j2', { kind: 'group_join', subjectKind: 'member', subjectId: CAROL.drepId, intent: join, requiredSigners: [CAROL.hash] }));
    await db.prepare("UPDATE pending_multisig_tx SET resolved_at = 5, resolution = 'applied' WHERE id = 'j2'").run();

    const bob = await unresolvedGroupActionsForDrep(db, BOB.drepId);
    expect(bob.map((r) => ({ id: r.id, kind: r.kind, groupId: r.groupId, status: r.status }))).toEqual([
      { id: 'c2', kind: 'group_create', groupId: newId, status: 'collecting' },
    ]);
    expect((await unresolvedGroupActionsForDrep(db, ALICE.drepId)).map((r) => r.id)).toEqual(['c2']);
    const carol = await unresolvedGroupActionsForDrep(db, CAROL.drepId);
    expect(carol.map((r) => ({ id: r.id, groupId: r.groupId }))).toEqual([{ id: 'j1', groupId: PERM_ID }]);
    expect(await unresolvedGroupActionsForDrep(db, DAVE.drepId)).toEqual([]);
    expect(await unresolvedGroupActionsForDrep(db, 'garbage')).toEqual([]);
  });

  it('reads rows stored under an old group id form as the current id', async () => {
    await seedPermissioned();
    const [, twoByte, legacy] = groupIdForms(PERM.ref);
    // A submitted approval stored with the legacy `group1` id as its subject and in its intent.
    await createGroupAction(db, rec('old', { subjectId: legacy, intent: { kind: 'group_approve', group: legacy, joins: [PERM.carolJoin] }, requiredSigners: [CAROL.hash] }));
    await db.prepare("UPDATE pending_multisig_tx SET status = 'submitted' WHERE id = 'old'").run();
    // Carol's own leave whose intent names the group in the 34 byte `drep_group1` form.
    const leave: GroupIntent = { kind: 'group_leave', group: twoByte, member: CAROL.drepId, join: PERM.carolJoin };
    await createGroupAction(db, rec('l3', { kind: 'group_leave', subjectKind: 'member', subjectId: CAROL.drepId, intent: leave, requiredSigners: [CAROL.hash] }));

    const group = await getGroup(db, PERM_ID);
    if (!group) throw new Error('seeded group missing');
    const s = await groupActionState(db, group, { drepId: CAROL.drepId });
    expect(s.rows.map((r) => ({ id: r.id, status: r.status, groupId: r.groupId }))).toEqual([{ id: 'old', status: 'submitted', groupId: PERM_ID }]);
    expect(s.viewerRows.map((r) => ({ id: r.id, groupId: r.groupId }))).toEqual([{ id: 'l3', groupId: PERM_ID }]);
    const carol = await unresolvedGroupActionsForDrep(db, CAROL.drepId);
    expect(carol.map((r) => ({ id: r.id, groupId: r.groupId })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'l3', groupId: PERM_ID },
      { id: 'old', groupId: PERM_ID },
    ]);
  });

  it('lets an open control row stored under an old id form hold the slot', async () => {
    await seedPermissioned();
    const [, twoByte] = groupIdForms(PERM.ref);
    const update = (id: string, group: string): NewGroupAction =>
      rec(id, { kind: 'group_update', subjectId: group, intent: { kind: 'group_update', group, approvals: [] }, controlSlot: true, requiredSigners: [ALICE.hash] });
    expect(await createGroupAction(db, update('u-old', twoByte))).toBe('created');
    expect(await createGroupAction(db, update('u-new', PERM_ID))).toBe('slot taken');
    expect((await openControlAction(db, PERM_ID))?.id).toBe('u-old');
  });

  it('reads the unresolved rows of a DRep through the subject and the unresolved indexes', async () => {
    const plan = (await planOf(db, UNRESOLVED_FOR_DREP_SQL, [CAROL.drepId, CAROL.hash, 20])).join('\n');
    expect(plan).toContain('pending_multisig_tx_subject');
    expect(plan).toContain('pending_multisig_tx_unresolved');
  });
});

describe('group action state route', () => {
  type StateBody = {
    viewer: { keyHash: string | null; join: { joinId: string; state: string } | null } | null;
    rows: Array<{ id: string | null; kind: string; status: string }>;
    pending: Array<{ joinId: string }>;
    control: { keys: string[] };
    error?: string;
  };
  const approve = (id: string, createdBy: string): NewGroupAction => ({
    id,
    kind: 'group_approve',
    subjectKind: 'group',
    subjectId: PERM_ID,
    intent: { kind: 'group_approve', group: PERM_ID, joins: [PERM.carolJoin] },
    nativeScriptJson: '{}',
    unsignedTxCbor: '84',
    bodyHash: id.padEnd(64, '0'),
    requiredSigners: [BOB.hash],
    invalidHereafter: 500,
    feeInputs: [{ txHash: 'ef'.repeat(32), index: 1 }],
    feePayKeys: ['12'.repeat(28)],
    eventCount: 1,
    controlSlot: false,
    profileHash: null,
    createdBy,
    now: 1000,
  });

  it('hands signing links only to the signers and gives the viewer its membership', async () => {
    await seedPermissioned();
    await createGroupAction(db, approve('a1', 'u-bob'));
    const anon = await call<StateBody>(stateRoute, null, { id: PERM_ID });
    expect(anon.status).toBe(200);
    expect(anon.json.viewer).toBeNull();
    expect(anon.json.rows).toEqual([{ id: null, kind: 'group_approve', status: 'collecting' }]);
    expect(anon.json.pending.map((p) => p.joinId)).toEqual([PERM.carolJoin]);
    expect(anon.json.control.keys).toEqual([ALICE.hash]);

    const bob = await call<StateBody>(stateRoute, sessionOf('u-x', BOB), { id: PERM_ID });
    expect(bob.json.rows[0].id).toBe('a1');
    const carol = await call<StateBody>(stateRoute, sessionOf('u-carol', CAROL), { id: PERM_ID });
    expect(carol.json.rows[0].id).toBeNull();
    expect(carol.json.viewer).toEqual({ keyHash: CAROL.hash, drepId: CAROL.drepId, join: { joinId: PERM.carolJoin, state: 'pending' } });
  });

  it('lists the active members with their joins for the remove control', async () => {
    await seedPermissioned();
    expect((await call<StateBody & { activeMembers: unknown[] }>(stateRoute, null, { id: PERM_ID })).json.activeMembers).toEqual([]);
    await seed([groupTx(50, { events: [{ tag: 'approve', join: parseJoinRef(PERM.carolJoin) }] }, [BOB])], 50);
    const res = await call<StateBody & { activeMembers: Array<{ joinId: string; drepId: string }> }>(stateRoute, null, { id: PERM_ID });
    expect(res.json.activeMembers.map((m) => [m.joinId, m.drepId])).toEqual([[PERM.carolJoin, CAROL.drepId]]);
    expect(res.json.pending).toEqual([]);
  });

  it('gives the server clock slot so a client with a wrong clock still builds a valid end', async () => {
    await seedPermissioned();
    const res = await call<StateBody & { serverSlot: number }>(stateRoute, null, { id: PERM_ID });
    expect(Math.abs(res.json.serverSlot - wallClockSlot('preprod'))).toBeLessThanOrEqual(2);
  });

  it('shows the open control action to admins only while they have not resigned', async () => {
    await seedPermissioned();
    const update: GroupIntent = { kind: 'group_update', group: PERM_ID, approvals: [] };
    const held = { ...approve('u1', 'u-alice'), kind: 'group_update' as const, intent: update, controlSlot: true, requiredSigners: [ALICE.hash] };
    await createGroupAction(db, held);
    type Slot = StateBody & { openControl: { id: string | null } | null };
    expect((await call<Slot>(stateRoute, sessionOf('u-bob', BOB), { id: PERM_ID })).json.openControl).toEqual({ id: 'u1' });
    // Bob resigns from admission, his only role.
    await seed([groupTx(50, { events: [{ tag: 'resign', group: PERM.ref, key: BOB.hash }] }, [BOB])], 50);
    expect((await call<Slot>(stateRoute, sessionOf('u-bob', BOB), { id: PERM_ID })).json.openControl).toEqual({ id: null });
  });

  it('answers 404 for an unknown group', async () => {
    const res = await call<StateBody>(stateRoute, null, { id: OTHER_ID });
    expect(res.status).toBe(404);
  });
});
