/// <reference types="@cloudflare/workers-types" />
// The group action routes over seeded engine state, with the library preview running for real and
// Koios faked. Transactions are written byte by byte and signed with fixed ed25519 test keys.
import { Transaction } from '@evolution-sdk/evolution';
import { env } from 'cloudflare:test';
import { decodeTransaction, encodeNativeScript, type GroupEvent, nativeScriptHash, type NativeScript, type PayloadInput } from 'drep-groups';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '@/lib/crypto/hex';
import { createPendingMultisig, getPendingMultisig, type PendingWitness } from '@/lib/db/pendingMultisigTx';
import { expectedPayload, type GroupIntent, parseJoinRef } from '@/lib/groups/actions';
import { decodeGroupTx } from '@/lib/groups/actionTx';
import { openControlAction } from '@/lib/groups/actionStore';
import { drepIdForCredential, groupIdParam, groupIdString } from '@/lib/groups/ids';
import { readGroupState } from '@/lib/groups/preview';
import {
  ALICE,
  auxFor,
  BOB,
  buildTx,
  CAROL,
  call,
  DAVE,
  ERIN,
  enterpriseAddress,
  FEE_INPUT,
  groupTx,
  PAY,
  PERM,
  SOLO,
  seed,
  seedPermissioned,
  seedSolo,
  seedUser,
  type SessionUser,
  sessionOf,
  type TestKey,
  TIP_SLOT,
  testKey,
  TTL,
  type TxParts,
  witnessSet,
} from './fixtures';

const net = vi.hoisted(() => ({ network: 'preprod' }));
vi.mock('@/lib/api/response', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/response')>()),
  currentNetwork: () => ({ network: net.network, koiosBaseUrl: 'https://koios.invalid/api/v1' }),
}));

const koios = vi.hoisted(() => ({
  tipSlot: 0,
  spent: new Set<string>(),
  retired: new Set<string>(),
  scripts: new Map<string, unknown>(),
  addresses: new Map<string, string>(),
  calls: 0,
}));
vi.mock('@/lib/koios/client', () => ({
  createKoiosClient: () => ({
    tip: async () => {
      koios.calls += 1;
      return { epoch_no: 1, block_no: 100, abs_slot: koios.tipSlot };
    },
    utxoInfo: async (refs: Array<{ txHash: string; index: number }>) => {
      koios.calls += 1;
      return refs.map((r) => ({
        ...r,
        address: koios.addresses.get(`${r.txHash}#${r.index}`) ?? enterpriseAddress(PAY).bech32,
        isSpent: koios.spent.has(`${r.txHash}#${r.index}`),
      }));
    },
    drepInfo: async (id: string) => ({
      drep_id: id,
      hex: '',
      has_script: false,
      drep_status: koios.retired.has(id) ? 'retired' : 'registered',
      deposit: null,
      active: true,
      expires_epoch_no: null,
    }),
    scriptInfo: async (hash: string) => (koios.scripts.has(hash) ? { script_hash: hash, type: 'timelock', value: koios.scripts.get(hash) } : null),
  }),
}));

import { GET } from '../[id]';
import { POST as cancel } from '../[id]/cancel';
import { POST as submit } from '../[id]/submit';
import { POST as submitted } from '../[id]/submitted';
import { POST as witness } from '../[id]/witness';
import { POST as create } from '../index';

const GID = groupIdString(PERM.ref);

beforeEach(() => {
  net.network = 'preprod';
  koios.tipSlot = TIP_SLOT;
  koios.spent.clear();
  koios.retired.clear();
  koios.scripts.clear();
  koios.addresses.clear();
  koios.calls = 0;
});

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

/**
 * Posts the intent with a tx around the payload. The tx lists `signers` as required signers,
 * `selected` is what the client claims to have selected.
 */
async function open(
  user: SessionUser,
  intent: GroupIntent,
  o: { payload: PayloadInput; selected?: string[]; signers?: string[]; tx?: Partial<TxParts> },
): Promise<{ status: number; json: { id?: string; error?: string }; bodyHash: string; hex: string }> {
  const t = buildTx({ payload: o.payload, requiredSigners: uniq(o.signers ?? o.selected ?? []), ...o.tx });
  const res = await call<{ id?: string; error?: string }>(create, user, { body: { intent, unsignedTxCbor: t.hex, selected: o.selected ?? [] } });
  return { ...res, bodyHash: t.bodyHash, hex: t.hex };
}

/** The payload the intent asks for in the seeded state. */
async function payloadIn(intent: GroupIntent): Promise<PayloadInput> {
  const ref = intent.kind === 'group_create' ? null : groupIdParam(intent.group);
  return expectedPayload(intent, ref ? await readGroupState(env.DB, ref) : null, new Map());
}

const sign = (id: string, user: SessionUser, bodyHash: string, ...keys: TestKey[]) =>
  call<{ accepted: string[]; ignored: string[]; satisfied: boolean; error?: string }>(witness, user, {
    id,
    body: { witnessSetHex: witnessSet(bodyHash, ...keys) },
  });

const alice = sessionOf('u-alice', ALICE);
const bob = sessionOf('u-bob', BOB);
const carol = sessionOf('u-carol', CAROL);
const dave = sessionOf('u-dave', DAVE);
const erin = sessionOf('u-erin', ERIN);

const soloCreate: GroupIntent = {
  kind: 'group_create',
  mode: 'open',
  control: { keys: [ALICE.hash], n: 1 },
  admission: null,
  founders: [ALICE.drepId],
  profile: null,
};
const approveCarol: GroupIntent = { kind: 'group_approve', group: GID, joins: [PERM.carolJoin] };
const dissolvePerm: GroupIntent = { kind: 'group_dissolve', group: GID };
const addErin: GroupIntent = { kind: 'group_update', group: GID, approvals: [], control: { keys: [ALICE.hash, ERIN.hash], n: 1 } };
const combined: GroupIntent = {
  kind: 'group_update',
  group: GID,
  approvals: [PERM.carolJoin],
  control: { keys: [ALICE.hash, CAROL.hash], n: 2 },
};

/** Opens the intent in the seeded state with the selected keys, the required signers being mandatory plus selected. */
async function openIn(user: SessionUser, intent: GroupIntent, selected: string[], mandatory: string[] = []) {
  return open(user, intent, { payload: await payloadIn(intent), selected, signers: [...mandatory, ...selected] });
}

describe('group action routes', () => {
  it('rejects auxiliary data swapped under the same body', async () => {
    const payload = expectedPayload(soloCreate, null, new Map());
    const other = expectedPayload({ ...soloCreate, mode: 'permissioned', admission: 'same' }, null, new Map());
    const res = await open(alice, soloCreate, { payload, signers: [ALICE.hash], tx: { swapAux: auxFor(other) } });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe('metadata does not match the transaction body');
    // The same body with its own metadata passes.
    expect((await open(alice, soloCreate, { payload, signers: [ALICE.hash] })).status).toBe(200);
  });

  it('rejects mismatching payload, extra event, wrong order and wrong required signers for every action kind', async () => {
    await seedPermissioned();
    const joinDave: GroupIntent = { kind: 'group_join', group: GID, member: DAVE.drepId };
    const leaveCarol: GroupIntent = { kind: 'group_leave', group: GID, member: CAROL.drepId, join: PERM.carolJoin };
    const removeCarol: GroupIntent = { kind: 'group_remove', group: GID, joins: [PERM.carolJoin] };
    const jointCreate: GroupIntent = {
      kind: 'group_create',
      mode: 'permissioned',
      control: { keys: [ALICE.hash, DAVE.hash], n: 1 },
      admission: 'same',
      founders: [ALICE.drepId, DAVE.drepId],
      profile: null,
    };
    const extra: GroupEvent = { tag: 'approve', join: parseJoinRef(`${'ee'.repeat(32)}#0`) };
    const cases: Array<[GroupIntent, SessionUser, string[]]> = [
      [jointCreate, alice, [ALICE.hash, DAVE.hash]],
      [joinDave, dave, [DAVE.hash]],
      [leaveCarol, carol, [CAROL.hash]],
      [approveCarol, bob, [BOB.hash]],
      [removeCarol, bob, [BOB.hash]],
      [combined, alice, [ALICE.hash, BOB.hash, CAROL.hash]],
      [dissolvePerm, alice, [ALICE.hash]],
    ];
    for (const [intent, user, signers] of cases) {
      const good = await payloadIn(intent);
      const selected = signers;
      const differ = { ...good, events: [...good.events.slice(0, -1), { ...extra, tag: 'remove' } as GroupEvent] };
      const results = [
        await open(user, intent, { payload: differ, selected, signers }),
        await open(user, intent, { payload: { ...good, events: [...good.events, extra] }, selected, signers }),
        await open(user, intent, { payload: good, selected, signers: [...signers, ERIN.hash] }),
      ];
      const reasons = results.map((r) => [r.status, r.json.error]);
      expect(reasons[0][0], intent.kind).toBe(422);
      expect(String(reasons[0][1]), intent.kind).toMatch(/differs from the action/);
      expect(reasons[1], intent.kind).toEqual([422, 'number of events differs from the action']);
      expect(reasons[2], intent.kind).toEqual([422, 'required signers differ from the selected signers']);
      if (good.events.length > 1) {
        const e = good.events;
        const swapped = [...e.slice(0, -2), e[e.length - 1], e[e.length - 2]];
        const reordered = await open(user, intent, { payload: { ...good, events: swapped }, selected, signers });
        expect(reordered.status, intent.kind).toBe(422);
        expect(String(reordered.json.error), intent.kind).toMatch(/differs from the action/);
      }
    }
  });

  it('refuses a combined action when the admission signature is missing, before storing and before submit', async () => {
    await seedPermissioned();
    // Before storing: without Bob the approval cannot satisfy the admission policy.
    const early = await openIn(alice, combined, [ALICE.hash], [CAROL.hash]);
    expect(early.json.error).toBe('the selected signers do not satisfy the action');
    expect(early.status).toBe(422);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pending_multisig_tx').first<{ n: number }>()).toEqual({ n: 0 });

    // Before submit: Bob is selected but never signs.
    const row = await openIn(alice, combined, [ALICE.hash, BOB.hash], [CAROL.hash]);
    expect(row.status).toBe(200);
    const id = row.json.id as string;
    expect((await sign(id, alice, row.bodyHash, PAY, ALICE)).json.accepted).toEqual([PAY.hash, ALICE.hash]);
    expect((await sign(id, carol, row.bodyHash, CAROL)).json.satisfied).toBe(false);
    const res = await call(submit, alice, { id, body: {} });
    expect(res).toEqual({ status: 409, json: { error: 'not every required signer has signed' } });
    expect((await sign(id, bob, row.bodyHash, BOB)).json.satisfied).toBe(true);
    expect((await call(submit, alice, { id, body: {} })).status).toBe(200);
  });

  it('refuses a signing link opened by a key the action does not need', async () => {
    await seedPermissioned();
    expect((await openIn(erin, approveCarol, [BOB.hash])).status).toBe(403);
    expect((await openIn(alice, approveCarol, [BOB.hash])).status).toBe(403);
    const row = await openIn(bob, approveCarol, [BOB.hash]);
    expect(row.status).toBe(200);
    const id = row.json.id as string;
    expect((await call(GET, erin, { id })).status).toBe(403);
    expect((await call(GET, carol, { id })).status).toBe(403);
    expect((await call(GET, null, { id })).status).toBe(401);
    expect((await sign(id, erin, row.bodyHash, ERIN)).status).toBe(403);
    const view = await call<Record<string, unknown>>(GET, bob, { id });
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({
      kind: 'group_approve',
      status: 'collecting',
      groupId: GID,
      requiredSigners: [BOB.hash],
      signed: [],
      satisfied: false,
      canSubmit: false,
      slotHeld: false,
      invalidHereafter: TTL,
      bodyHash: row.bodyHash,
    });
    expect((view.json.lines as string[])[0]).toMatch(/^Approve /);
  });

  it('refuses a second control action while one is open and shows it', async () => {
    await seedPermissioned();
    const first = await openIn(alice, dissolvePerm, [ALICE.hash]);
    expect(first.status).toBe(200);
    const second = await openIn(alice, addErin, [ALICE.hash], [ERIN.hash]);
    expect(second).toMatchObject({ status: 409, json: { error: 'slot taken', id: first.json.id } });
    // Admission actions hold no slot.
    expect((await openIn(bob, approveCarol, [BOB.hash])).status).toBe(200);
    expect((await call(GET, alice, { id: first.json.id })).json).toMatchObject({ slotHeld: true });
  });

  it('tells the initiator apart and hands only the initiator the fee inputs', async () => {
    await seedPermissioned();
    const first = await openIn(alice, combined, [ALICE.hash, BOB.hash], [CAROL.hash]);
    const id = first.json.id as string;
    expect((await call(GET, alice, { id })).json).toMatchObject({ isInitiator: true, feeInputs: [FEE_INPUT] });
    const other = await call(GET, bob, { id });
    expect(other.status).toBe(200);
    expect(other.json).toMatchObject({ isInitiator: false, feeInputs: [] });
  });

  it('frees the slot when seq moved under a collecting action', async () => {
    await seedPermissioned();
    const first = await openIn(alice, dissolvePerm, [ALICE.hash]);
    const id = first.json.id as string;
    // A foreign update with an empty change set moves seq to 1.
    await seed([groupTx(50, { events: [{ tag: 'update', group: PERM.ref, seq: 0n, changes: {} }] }, [ALICE])], 50);
    expect((await sign(id, alice, first.bodyHash, ALICE)).json).toEqual({ error: 'stale' });
    const row = await getPendingMultisig(env.DB, id);
    expect(row).toMatchObject({ status: 'cancelled', resolution: 'failed' });
    expect(await openControlAction(env.DB, GID)).toBeNull();
    expect((await openIn(alice, dissolvePerm, [ALICE.hash])).status).toBe(200);
  });

  it('frees a stale slot when the next control action is opened', async () => {
    await seedPermissioned();
    const first = await openIn(alice, dissolvePerm, [ALICE.hash]);
    await seed([groupTx(50, { events: [{ tag: 'update', group: PERM.ref, seq: 0n, changes: {} }] }, [ALICE])], 50);
    const next = await openIn(alice, dissolvePerm, [ALICE.hash]);
    expect(next.status).toBe(200);
    expect(await getPendingMultisig(env.DB, first.json.id as string)).toMatchObject({ resolution: 'failed' });
  });

  it('keeps the slot after cancel until expiry or the fee input is spent', async () => {
    await seedPermissioned();
    const first = await openIn(alice, addErin, [ALICE.hash], [ERIN.hash]);
    const id = first.json.id as string;
    expect((await call(cancel, erin, { id, body: {} })).status).toBe(403);
    expect(await call(cancel, alice, { id, body: {} })).toEqual({ status: 200, json: { ok: true, feeInputs: [FEE_INPUT] } });
    expect((await sign(id, erin, first.bodyHash, ERIN)).json).toEqual({ error: 'no longer collecting' });
    expect(await openControlAction(env.DB, GID)).toMatchObject({ id, status: 'cancelled' });
    expect((await openIn(alice, dissolvePerm, [ALICE.hash])).json).toMatchObject({ error: 'slot taken', id });
    // The resolver marks it never included once expired or its fee input spent, which frees the slot.
    await env.DB.prepare(`UPDATE pending_multisig_tx SET resolution = 'never_included', resolved_at = 1, never_included_at = 1 WHERE id = ?`)
      .bind(id)
      .run();
    expect((await openIn(alice, dissolvePerm, [ALICE.hash])).status).toBe(200);
  });

  it('refuses a witness while a fee input is spent', async () => {
    await seedPermissioned();
    const row = await openIn(bob, approveCarol, [BOB.hash]);
    koios.spent.add(`${FEE_INPUT.txHash}#${FEE_INPUT.index}`);
    expect((await sign(row.json.id as string, bob, row.bodyHash, BOB)).json).toEqual({ error: 'fee input spent' });
  });

  it('accepts a witness of a newly listed key', async () => {
    await seedPermissioned();
    const row = await openIn(alice, addErin, [ALICE.hash], [ERIN.hash]);
    expect(row.status).toBe(200);
    const id = row.json.id as string;
    expect((await sign(id, erin, row.bodyHash, ERIN)).json).toEqual({ accepted: [ERIN.hash], ignored: [], satisfied: false });
    expect((await sign(id, alice, row.bodyHash, PAY, ALICE)).json).toEqual({ accepted: [PAY.hash, ALICE.hash], ignored: [], satisfied: true });
    const view = await call<Record<string, unknown>>(GET, erin, { id });
    expect(view.json).toMatchObject({ signed: [ERIN.hash, ALICE.hash], satisfied: true, canSubmit: true });
  });

  it('splits a wallet witness set and ignores unneeded keys', async () => {
    await seedPermissioned();
    const row = await openIn(bob, approveCarol, [BOB.hash]);
    const id = row.json.id as string;
    // Payment witness first, the DRep key second, then a key the action does not need.
    expect((await sign(id, bob, row.bodyHash, PAY, BOB, DAVE)).json).toEqual({ accepted: [PAY.hash, BOB.hash], ignored: [DAVE.hash], satisfied: true });
    const stored = JSON.parse((await getPendingMultisig(env.DB, id))?.witnesses ?? '[]') as PendingWitness[];
    expect(stored.map((w) => [w.key_hash, w.role])).toEqual([
      [PAY.hash, 'funding'],
      [BOB.hash, 'signer'],
    ]);
    expect(stored[1].witness_hex).toBe(witnessSet(row.bodyHash, BOB));
    // A witness signed over another body is refused as a whole.
    const other = await sign(id, bob, 'ab'.repeat(32), BOB);
    expect(other.status).toBe(422);

    const assembled = await call<{ assembledTxHex: string }>(submit, bob, { id, body: {} });
    expect(assembled.status).toBe(200);
    const tx = decodeTransaction(hexToBytes(assembled.json.assembledTxHex), { txHash: row.bodyHash, blockHeight: 0, txIndex: 0 });
    expect(uniq(tx.witnessKeyHashes)).toEqual(uniq([PAY.hash, BOB.hash]));
    // Folding the witnesses in keeps the body bytes, so the tx hash stays the body hash.
    expect(decodeGroupTx(assembled.json.assembledTxHex).bodyHash).toBe(row.bodyHash);
  });

  it('keeps a payment key of someone other than the initiator out', async () => {
    await seedPermissioned();
    const row = await openIn(alice, addErin, [ALICE.hash], [ERIN.hash]);
    expect((await sign(row.json.id as string, erin, row.bodyHash, PAY, ERIN)).json).toMatchObject({ accepted: [ERIN.hash], ignored: [PAY.hash] });
  });

  it('refuses an outsider proposing an update that adds themselves', async () => {
    await seedPermissioned();
    const res = await openIn(erin, addErin, [ALICE.hash], [ERIN.hash]);
    expect(res).toMatchObject({ status: 403 });
    expect(await openControlAction(env.DB, GID)).toBeNull();
  });

  it('refuses a key added to a policy that is not a registered DRep', async () => {
    await seedPermissioned();
    koios.retired.add(ERIN.drepId);
    const res = await openIn(alice, addErin, [ALICE.hash], [ERIN.hash]);
    expect(res).toMatchObject({ status: 422, json: { error: `key ${ERIN.hash} is not a registered DRep` } });
  });

  it('refuses a validity end missing or too far ahead', async () => {
    const payload = expectedPayload(soloCreate, null, new Map());
    expect((await open(alice, soloCreate, { payload, signers: [ALICE.hash], tx: { invalidHereafter: null } })).json.error).toBe(
      'transaction has no validity end',
    );
    expect((await open(alice, soloCreate, { payload, signers: [ALICE.hash], tx: { invalidHereafter: TTL + 601 } })).json.error).toBe(
      'validity end too far ahead',
    );
    expect((await open(alice, soloCreate, { payload, signers: [ALICE.hash], tx: { invalidHereafter: TTL + 600 } })).status).toBe(200);
  });

  it('refuses a transaction that carries witnesses or extra governance content', async () => {
    const payload = expectedPayload(soloCreate, null, new Map());
    const t = buildTx({ payload, requiredSigners: [ALICE.hash] });
    // The same tx with Alice's witness already in its witness set.
    const signedHex = Transaction.addVKeyWitnessesHex(t.hex, witnessSet(t.bodyHash, ALICE));
    const res = await call(create, alice, { body: { intent: soloCreate, unsignedTxCbor: signedHex, selected: [] } });
    expect(res).toEqual({ status: 422, json: { error: 'transaction must carry no witnesses' } });
    // A stake registration certificate next to the payload.
    const cert = await open(alice, soloCreate, { payload, signers: [ALICE.hash], tx: { extraBody: [[4, [[0, [0, hexToBytes(ALICE.hash)]]]]] } });
    expect(cert.json.error).toBe('transaction carries certificates');
  });

  it('accepts the first create of a DRep DRepTalk never tracked', async () => {
    const payload = expectedPayload(soloCreate, null, new Map());
    const row = await open(alice, soloCreate, { payload, signers: [ALICE.hash] });
    expect(row.status).toBe(200);
    const id = row.json.id as string;
    const stored = await getPendingMultisig(env.DB, id);
    expect(stored).toMatchObject({
      action: 'group_create',
      subject_kind: 'group',
      drep_id: groupIdString({ txHash: row.bodyHash, index: 0 }),
      body_hash: row.bodyHash,
      event_count: 2,
      required_signers: JSON.stringify([ALICE.hash]),
      invalid_hereafter: TTL,
      fee_inputs: JSON.stringify([FEE_INPUT]),
      fee_pay_keys: JSON.stringify([PAY.hash]),
      control_slot: 0,
      profile_hash: null,
      status: 'collecting',
    });
    expect(stored?.native_script).toContain(ALICE.hash);
    expect((stored?.expires_at ?? 0) - (stored?.created_at ?? 0)).toBe(172_800);

    expect((await sign(id, alice, row.bodyHash, PAY, ALICE)).json).toMatchObject({ satisfied: true });
    expect((await call(submit, alice, { id, body: {} })).status).toBe(200);
    expect((await call(submitted, alice, { id, body: { txHash: 'ab'.repeat(32) } })).status).toBe(422);
    expect(await call(submitted, alice, { id, body: { txHash: row.bodyHash.toUpperCase() } })).toEqual({ status: 200, json: { ok: true } });
    expect(await getPendingMultisig(env.DB, id)).toMatchObject({ status: 'submitted', tx_hash: row.bodyHash });
  });

  it('refuses a create whose founder is not a registered DRep', async () => {
    koios.retired.add(ALICE.drepId);
    const payload = expectedPayload(soloCreate, null, new Map());
    expect((await open(alice, soloCreate, { payload, signers: [ALICE.hash] })).status).toBe(422);
  });

  it('refuses a submit without the funding witness', async () => {
    const payload = expectedPayload(soloCreate, null, new Map());
    const row = await open(alice, soloCreate, { payload, signers: [ALICE.hash] });
    const id = row.json.id as string;
    await sign(id, alice, row.bodyHash, ALICE);
    expect(await call(submit, alice, { id, body: {} })).toEqual({ status: 409, json: { error: 'funding signature missing' } });
  });

  it('refuses a second approve of an already approved request', async () => {
    await seedPermissioned();
    const first = await openIn(bob, approveCarol, [BOB.hash]);
    expect(first.status).toBe(200);
    // Somebody approves Carol on chain meanwhile.
    await seed([groupTx(50, { events: [{ tag: 'approve', join: parseJoinRef(PERM.carolJoin) }] }, [BOB])], 50);
    const second = await openIn(bob, approveCarol, [BOB.hash]);
    expect(second.status).toBe(422);
    expect((await sign(first.json.id as string, bob, first.bodyHash, BOB)).json).toEqual({ error: 'stale' });
  });

  it('lets exactly one submitted claim win', async () => {
    const payload = expectedPayload(soloCreate, null, new Map());
    const row = await open(alice, soloCreate, { payload, signers: [ALICE.hash] });
    const id = row.json.id as string;
    const claims = await Promise.all([1, 2, 3].map(() => call(submitted, alice, { id, body: { txHash: row.bodyHash } })));
    expect(claims.map((c) => c.status).sort()).toEqual([200, 409, 409]);
  });

  it('lets a group signer dissolve a solo group', async () => {
    await seedSolo();
    const signer = sessionOf('u-alice', ALICE, 'group-signer');
    const intent: GroupIntent = { kind: 'group_dissolve', group: groupIdString(SOLO.ref) };
    const row = await openIn(signer, intent, [ALICE.hash]);
    expect(row.status).toBe(200);
    const id = row.json.id as string;
    expect((await sign(id, signer, row.bodyHash, PAY, ALICE)).json).toMatchObject({ satisfied: true });
    expect((await call(submit, signer, { id, body: {} })).status).toBe(200);
  });

  it('gates a script DRep join on the session DRep', async () => {
    await seedPermissioned();
    const script: NativeScript = { type: 'sig', keyHash: CAROL.hash };
    const hash = nativeScriptHash(encodeNativeScript(script));
    koios.scripts.set(hash, { type: 'sig', keyHash: CAROL.hash });
    const scriptDrep = drepIdForCredential({ kind: 'script', hash });
    const self: SessionUser = { id: 'u-script', roles: ['drep'], drepId: scriptDrep };
    const otherScript: SessionUser = { id: 'u-other', roles: ['drep'], drepId: drepIdForCredential({ kind: 'script', hash: 'cd'.repeat(28) }) };
    const intent: GroupIntent = { kind: 'group_join', group: GID, member: scriptDrep };
    expect((await openIn(carol, intent, [CAROL.hash])).status).toBe(403);
    expect((await openIn(otherScript, intent, [CAROL.hash])).status).toBe(403);
    const row = await openIn(self, intent, [CAROL.hash]);
    expect(row.status).toBe(200);
    const id = row.json.id as string;
    expect(await getPendingMultisig(env.DB, id)).toMatchObject({ subject_kind: 'member', drep_id: scriptDrep });
    expect((await call(GET, carol, { id })).status).toBe(403);
    expect((await call(GET, self, { id })).status).toBe(200);
    expect((await sign(id, self, row.bodyHash, CAROL)).json).toMatchObject({ accepted: [CAROL.hash], satisfied: true });
  });

  it('sends signature requests to selected signers except the initiator', async () => {
    await seedPermissioned();
    for (const [id, k] of [['u-alice', ALICE], ['u-bob', BOB], ['u-carol', CAROL], ['u-erin', ERIN]] as const) await seedUser(id, k.drepId);
    const row = await openIn(alice, combined, [ALICE.hash, BOB.hash], [CAROL.hash]);
    expect(row.status).toBe(200);
    const { results } = await env.DB.prepare('SELECT recipient_id, type, event_key, payload FROM notifications ORDER BY recipient_id').all<
      Record<string, string>
    >();
    expect(results.map((r) => [r.recipient_id, r.type, r.event_key])).toEqual([
      ['u-bob', 'group_signature_request', `group-sign:${row.json.id}`],
      ['u-carol', 'group_signature_request', `group-sign:${row.json.id}`],
    ]);
    expect(JSON.parse(results[0].payload)).toMatchObject({ groupId: GID, actionId: row.json.id });
    expect(JSON.parse(results[0].payload).summary).toMatch(/^Approve .*, Change management/);
  });

  it('refuses a witness after expiry', async () => {
    await seedPermissioned();
    const row = await openIn(bob, approveCarol, [BOB.hash]);
    koios.tipSlot = TTL + 1;
    const res = await sign(row.json.id as string, bob, row.bodyHash, BOB);
    expect(res).toEqual({ status: 410, json: { error: 'expired' } });
    expect((await call(submit, bob, { id: row.json.id, body: {} })).status).toBe(410);
  });

  it('answers 404 off preprod and for vote rows', async () => {
    await createPendingMultisig(env.DB, {
      id: 'vote-row',
      drepId: ALICE.drepId,
      action: 'vote',
      actionParams: '{}',
      unsignedTxCbor: '00',
      bodyHash: 'ab'.repeat(32),
      nativeScript: '{}',
      createdBy: 'u-alice',
      createdAt: 1,
      expiresAt: 2,
    });
    for (const route of [GET, witness, submit, submitted, cancel]) {
      expect((await call(route as never, alice, { id: 'vote-row', body: route === GET ? undefined : {} })).status).toBe(404);
    }
    net.network = 'mainnet';
    expect((await open(alice, soloCreate, { payload: expectedPayload(soloCreate, null, new Map()), signers: [ALICE.hash] })).status).toBe(404);
  });

  it('refuses a transaction that is not a definite four element array', async () => {
    const t = buildTx({ payload: expectedPayload(soloCreate, null, new Map()), requiredSigners: [ALICE.hash] });
    const indefinite = `9f${t.hex.slice(2)}ff`;
    const res = await call(create, alice, { body: { intent: soloCreate, unsignedTxCbor: indefinite, selected: [] } });
    expect(res).toEqual({ status: 422, json: { error: 'transaction must be a definite four element array' } });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pending_multisig_tx').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('treats the tip at the validity end as expired', async () => {
    await seedPermissioned();
    const row = await openIn(bob, approveCarol, [BOB.hash]);
    koios.tipSlot = TTL;
    expect(await sign(row.json.id as string, bob, row.bodyHash, BOB)).toEqual({ status: 410, json: { error: 'expired' } });
  });

  it('shows submit only when every fee input payment key signed, across two addresses', async () => {
    await seedPermissioned();
    const PAY2 = testKey(8);
    const FEE2 = { txHash: 'f2'.repeat(32), index: 3 };
    koios.addresses.set(`${FEE2.txHash}#${FEE2.index}`, enterpriseAddress(PAY2).bech32);
    const row = await open(bob, approveCarol, { payload: await payloadIn(approveCarol), selected: [BOB.hash], tx: { inputs: [FEE_INPUT, FEE2] } });
    expect(row.status).toBe(200);
    const id = row.json.id as string;
    await sign(id, bob, row.bodyHash, PAY, BOB);
    expect((await call(GET, bob, { id })).json).toMatchObject({ satisfied: true, canSubmit: false });
    expect(await call(submit, bob, { id, body: {} })).toEqual({ status: 409, json: { error: 'funding signature missing' } });
    expect((await sign(id, bob, row.bodyHash, PAY2)).json).toMatchObject({ accepted: [PAY2.hash] });
    expect((await call(GET, bob, { id })).json).toMatchObject({ canSubmit: true });
    expect((await call(submit, bob, { id, body: {} })).status).toBe(200);
  });

  it('counts a payment key stored as signer for the funding', async () => {
    // The initiator pays from an address of its own DRep key.
    koios.addresses.set(`${FEE_INPUT.txHash}#${FEE_INPUT.index}`, enterpriseAddress(ALICE).bech32);
    const row = await open(alice, soloCreate, { payload: expectedPayload(soloCreate, null, new Map()), signers: [ALICE.hash] });
    const id = row.json.id as string;
    expect((await sign(id, alice, row.bodyHash, ALICE)).json).toMatchObject({ accepted: [ALICE.hash] });
    const stored = JSON.parse((await getPendingMultisig(env.DB, id))?.witnesses ?? '[]') as PendingWitness[];
    expect(stored.map((w) => w.role)).toEqual(['signer']);
    expect((await call(GET, alice, { id })).json).toMatchObject({ canSubmit: true });
    expect((await call(submit, alice, { id, body: {} })).status).toBe(200);
  });

  it('answers 409 for a row whose group state is missing and 503 for a record that does not read', async () => {
    await seedPermissioned();
    const row = await openIn(bob, approveCarol, [BOB.hash]);
    const id = row.json.id as string;
    const gone: GroupIntent = { ...approveCarol, group: groupIdString({ txHash: '77'.repeat(32), index: 0 }) };
    await env.DB.prepare('UPDATE pending_multisig_tx SET action_params = ? WHERE id = ?').bind(JSON.stringify(gone), id).run();
    expect((await call(GET, bob, { id })).status).toBe(409);
    for (const route of [witness, submit, cancel]) {
      expect((await call(route, bob, { id, body: { witnessSetHex: witnessSet(row.bodyHash, BOB) } })).status).toBe(409);
    }
    await env.DB.prepare(`UPDATE pending_multisig_tx SET action_params = ?, unsigned_tx_cbor = '00' WHERE id = ?`)
      .bind(JSON.stringify(approveCarol), id)
      .run();
    // A record that does not read is a server fault, not a missing group.
    expect(await call(GET, bob, { id })).toEqual({ status: 503, json: { error: 'service unavailable' } });
  });

  it('tells a cancelled row apart from a submitted one', async () => {
    const row = await open(alice, soloCreate, { payload: expectedPayload(soloCreate, null, new Map()), signers: [ALICE.hash] });
    const id = row.json.id as string;
    await call(cancel, alice, { id, body: {} });
    expect(await call(submitted, alice, { id, body: { txHash: row.bodyHash } })).toEqual({ status: 409, json: { error: 'action was cancelled' } });
  });

  it('asks Koios nothing on a GET while signatures are missing and once when they are complete', async () => {
    await seedPermissioned();
    const row = await openIn(bob, approveCarol, [BOB.hash]);
    const id = row.json.id as string;
    koios.calls = 0;
    expect((await call(GET, bob, { id })).json).toMatchObject({ canSubmit: false });
    expect(koios.calls).toBe(0);
    await sign(id, bob, row.bodyHash, BOB);
    koios.calls = 0;
    // Bob signed, the funding witness is still missing.
    expect((await call(GET, bob, { id })).json).toMatchObject({ satisfied: true, canSubmit: false });
    expect(koios.calls).toBe(0);
    await sign(id, bob, row.bodyHash, PAY);
    koios.calls = 0;
    expect((await call(GET, bob, { id })).json).toMatchObject({ canSubmit: true });
    expect(koios.calls).toBeLessThanOrEqual(1);
    koios.spent.add(`${FEE_INPUT.txHash}#${FEE_INPUT.index}`);
    expect((await call(GET, bob, { id })).json).toMatchObject({ canSubmit: false });
  });

  it('refuses a create whose fee input is already spent', async () => {
    koios.spent.add(`${FEE_INPUT.txHash}#${FEE_INPUT.index}`);
    const res = await open(alice, soloCreate, { payload: expectedPayload(soloCreate, null, new Map()), signers: [ALICE.hash] });
    expect(res).toMatchObject({ status: 422, json: { error: 'fee input spent' } });
  });
});
