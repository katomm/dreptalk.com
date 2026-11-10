/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import {
  type Credential,
  credKey,
  encodeNativeScript,
  encodePayload,
  type EventRef,
  type GroupEvent,
  majorityScript,
  type NativeScript,
  nativeScriptHash,
  type PayloadInput,
} from 'drep-groups';
import { describe, expect, it } from 'vitest';
import { cbor, deliver, type Input, keyHex as K, labelTx, ledgerRow, settle, txHex as T } from './__tests__/loadFixtures.js';
import { KOIOS_BATCH_CONCURRENCY } from '../koios/concurrency.js';
import { ENGINE_BUDGET } from './constants.js';
import { type LiveFacts, liveFactsFor, PreviewUnavailable, previewGroupTx, readGroupState } from './preview.js';
import { acquireLease, invocationOwner } from './store/lease.js';
import { openRecovery } from './store/recovery.js';

const [ALICE, BOB, CAROL, DAVE] = [K(1), K(2), K(3), K(4)];
const key = (hash: string): Credential => ({ kind: 'key', hash });
const control = majorityScript([ALICE], 1);
const admission = majorityScript([BOB], 1);
const GROUP: EventRef = { txHash: T(10), index: 0 };
const CAROL_JOIN: EventRef = { txHash: T(30), index: 0 };

/** A Conway tx around the payload bytes, with required signers and an optional validity interval. */
function txBytes(payload: PayloadInput, o: { rs?: string[]; invalidBefore?: number; invalidHereafter?: number } = {}): Uint8Array {
  const body = new Map<number, Parameters<typeof cbor>[0]>([
    [0, []],
    [1, []],
    [2, 170_000],
  ]);
  if (o.invalidHereafter !== undefined) body.set(3, o.invalidHereafter);
  if (o.invalidBefore !== undefined) body.set(8, o.invalidBefore);
  if (o.rs?.length) body.set(14, o.rs.map((k) => Uint8Array.from(k.match(/../g) ?? [], (b) => Number.parseInt(b, 16))));
  const label = cbor(8416);
  return Uint8Array.from([0x84, ...cbor(body), ...cbor(new Map()), 0xf5, 0xa1, ...label, ...encodePayload(payload)]);
}

const live = (o: { registered?: Credential[]; scripts?: Array<[Credential, NativeScript]>; asked?: Credential[] } = {}): LiveFacts => ({
  registered: new Set((o.registered ?? []).map(credKey)),
  memberScripts: new Map((o.scripts ?? []).map(([c, s]) => [credKey(c), s])),
  asked: new Set([...(o.asked ?? []), ...(o.registered ?? [])].map(credKey)),
});

const lease = async (): Promise<string> => (await acquireLease(env.DB, invocationOwner())) as string;

/**
 * A permissioned group at 10 with control Alice and admission Bob, Carol registered at 20 and her
 * request to join at 30, Dave registered at 40, all applied.
 */
async function seedPermissioned(l: string, extra: Input[] = [], top = 40): Promise<void> {
  const create: GroupEvent = { tag: 'create', mode: 'permissioned', control: control.hash, admission: admission.hash, profile: null };
  const join: GroupEvent = { tag: 'join', group: GROUP, member: key(CAROL) };
  await deliver(
    env.DB,
    l,
    [
      { tx: labelTx(10, 10, { payload: encodePayload({ events: [create], scripts: [control.script, admission.script] }), rs: [ALICE, BOB], wk: [ALICE, BOB] }) },
      { ledger: ledgerRow(20, 20, key(CAROL), 'reg') },
      { tx: labelTx(30, 30, { payload: encodePayload({ events: [join] }), rs: [CAROL] }) },
      { ledger: ledgerRow(40, 40, key(DAVE), 'reg') },
      ...extra,
    ],
    top,
  );
  await settle(env.DB, l, ENGINE_BUDGET);
}

const verdicts = (p: Awaited<ReturnType<typeof previewGroupTx>>) => {
  if (!('events' in p)) throw new Error(`preview ignored: ${p.ignored}`);
  return p.events.map((e) => [e.tag, e.valid, e.reason]);
};

describe('previewGroupTx', () => {
  it('previews an approval against the stored state', async () => {
    await seedPermissioned(await lease());
    const tx = txBytes({ events: [{ tag: 'approve', join: CAROL_JOIN }] });
    expect(verdicts(await previewGroupTx(env.DB, tx, [], [BOB], live()))).toEqual([['approve', true, null]]);
    expect(verdicts(await previewGroupTx(env.DB, tx, [], [ALICE], live()))).toEqual([['approve', false, 'admission policy not satisfied']]);
  });

  it('reads the stored group state with its policies', async () => {
    await seedPermissioned(await lease());
    const s = await readGroupState(env.DB, GROUP);
    expect(s).toMatchObject({ ref: GROUP, mode: 'permissioned', status: 'active', seq: 0n });
    expect(s?.control.hash).toBe(control.hash);
    expect(s?.admission?.hash).toBe(admission.hash);
    expect(s?.control).toMatchObject(control.script);
    expect(await readGroupState(env.DB, { txHash: T(11), index: 0 })).toBeNull();
  });

  it('previews a first founder join for a registered DRep DRepTalk never tracked', async () => {
    const founder = majorityScript([ALICE], 1);
    const payload: PayloadInput = {
      events: [
        { tag: 'create', mode: 'open', control: founder.hash, admission: null, profile: null },
        { tag: 'join', group: { local: 0 }, member: key(ALICE) },
      ],
      scripts: [founder.script],
    };
    const tx = txBytes(payload, { rs: [ALICE] });
    expect(verdicts(await previewGroupTx(env.DB, tx, [ALICE], [ALICE], live({ registered: [key(ALICE)] })))).toEqual([
      ['create', true, null],
      ['join', true, null],
    ]);
    expect(verdicts(await previewGroupTx(env.DB, tx, [ALICE], [ALICE], live({ asked: [key(ALICE)] })))).toEqual([
      ['create', true, null],
      ['join', false, 'not a registered DRep'],
    ]);
  });

  it('previews a script DRep join with an after lock in the interval', async () => {
    await seedPermissioned(await lease());
    const script: NativeScript = { type: 'all', scripts: [{ type: 'sig', keyHash: K(7) }, { type: 'after', slot: 100n }] };
    const member: Credential = { kind: 'script', hash: nativeScriptHash(encodeNativeScript(script)) };
    const facts = live({ registered: [member], scripts: [[member, script]] });
    const payload: PayloadInput = { events: [{ tag: 'join', group: GROUP, member }] };
    expect(verdicts(await previewGroupTx(env.DB, txBytes(payload, { invalidBefore: 200 }), [], [K(7)], facts))).toEqual([['join', true, null]]);
    expect(verdicts(await previewGroupTx(env.DB, txBytes(payload), [], [K(7)], facts))).toEqual([['join', false, 'member script not satisfied']]);
  });

  it('rejects a join of a DRep the store holds as registered but Koios reports retired', async () => {
    await seedPermissioned(await lease());
    const tx = txBytes({ events: [{ tag: 'join', group: GROUP, member: key(DAVE) }] }, { rs: [DAVE] });
    expect(verdicts(await previewGroupTx(env.DB, tx, [DAVE], [DAVE], live()))).toEqual([['join', true, null]]);
    expect(verdicts(await previewGroupTx(env.DB, tx, [DAVE], [DAVE], live({ asked: [key(DAVE)] })))).toEqual([
      ['join', false, 'not a registered DRep'],
    ]);
  });

  it('previews a combined approve and update with the admission signature missing as partly invalid', async () => {
    await seedPermissioned(await lease());
    const next = majorityScript([ALICE, CAROL], 2);
    const payload: PayloadInput = {
      events: [
        { tag: 'approve', join: CAROL_JOIN },
        { tag: 'update', group: GROUP, seq: 0n, changes: { control: next.hash } },
      ],
      scripts: [next.script],
    };
    const tx = txBytes(payload);
    expect(verdicts(await previewGroupTx(env.DB, tx, [ALICE, CAROL], [ALICE, CAROL], live()))).toEqual([
      ['approve', false, 'admission policy not satisfied'],
      ['update', true, null],
    ]);
    expect(verdicts(await previewGroupTx(env.DB, tx, [ALICE, CAROL], [ALICE, BOB, CAROL], live()))).toEqual([
      ['approve', true, null],
      ['update', true, null],
    ]);
  });

  it('refuses the preview while the ledger frontier lags', async () => {
    const l = await lease();
    await seedPermissioned(l);
    const tx = txBytes({ events: [{ tag: 'approve', join: CAROL_JOIN }] });
    await env.DB.prepare('UPDATE drep_group_meta SET R = L - 1 WHERE id = 1').run();
    await expect(previewGroupTx(env.DB, tx, [], [BOB], live())).rejects.toBeInstanceOf(PreviewUnavailable);
    await env.DB.prepare('UPDATE drep_group_meta SET R = L WHERE id = 1').run();
    expect(verdicts(await previewGroupTx(env.DB, tx, [], [BOB], live()))).toEqual([['approve', true, null]]);
  });

  it('refuses the preview while the engine has work left or a recovery is open', async () => {
    const l = await lease();
    await seedPermissioned(l);
    const tx = txBytes({ events: [{ tag: 'approve', join: CAROL_JOIN }] });
    // A new join stored but not yet applied.
    await deliver(env.DB, l, [{ tx: labelTx(50, 50, { payload: encodePayload({ events: [{ tag: 'join', group: GROUP, member: key(DAVE) }] }), rs: [DAVE] }) }], 50);
    await expect(previewGroupTx(env.DB, tx, [], [BOB], live())).rejects.toBeInstanceOf(PreviewUnavailable);
    await settle(env.DB, l, ENGINE_BUDGET);
    expect(verdicts(await previewGroupTx(env.DB, tx, [], [BOB], live()))).toEqual([['approve', true, null]]);
    await openRecovery(env.DB, { kind: 'truncate', above: 45 }, l);
    await expect(previewGroupTx(env.DB, tx, [], [BOB], live())).rejects.toBeInstanceOf(PreviewUnavailable);
  });
});

describe('liveFactsFor', () => {
  it('reads registration and verified member scripts from Koios', async () => {
    const script: NativeScript = { type: 'nOfK', n: 1n, scripts: [{ type: 'sig', keyHash: K(7) }, { type: 'before', slot: 900n }] };
    const member: Credential = { kind: 'script', hash: nativeScriptHash(encodeNativeScript(script)) };
    const wrong: Credential = { kind: 'script', hash: K(8) };
    const json = { type: 'atLeast', required: 1, scripts: [{ type: 'sig', keyHash: K(7) }, { type: 'before', slot: 900 }] };
    const koios = {
      drepInfo: async (id: string) =>
        ({ drep_id: id, hex: '', has_script: false, drep_status: 'registered', deposit: null, active: true, expires_epoch_no: null }) as never,
      scriptInfo: async (hash: string) => ({ script_hash: hash, type: 'timelock', value: json }) as never,
    };
    const facts = await liveFactsFor(koios, [member, wrong, key(ALICE), key(ALICE)]);
    expect(facts.asked.size).toBe(3);
    expect(facts.registered.has(credKey(member))).toBe(true);
    expect(facts.memberScripts.get(credKey(member))).toEqual(script);
    // Koios answered with a script whose hash is not the credential's.
    expect(facts.memberScripts.has(credKey(wrong))).toBe(false);
    const retired = await liveFactsFor({ ...koios, drepInfo: async () => null }, [key(ALICE)]);
    expect(retired.registered.size).toBe(0);
    expect(retired.asked.has(credKey(key(ALICE)))).toBe(true);
  });

  it('keeps at most the Koios batch window in flight for many founders', async () => {
    let inFlight = 0;
    let peak = 0;
    const koios = {
      drepInfo: async (id: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { drep_id: id, hex: '', has_script: false, drep_status: 'registered', deposit: null, active: true, expires_epoch_no: null } as never;
      },
      scriptInfo: async () => null,
    };
    const founders = Array.from({ length: 63 }, (_, i) => key(K(100 + i)));
    const facts = await liveFactsFor(koios, founders);
    expect(facts.registered.size).toBe(63);
    expect(peak).toBeLessThanOrEqual(KOIOS_BATCH_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
