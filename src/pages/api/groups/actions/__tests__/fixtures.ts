/// <reference types="@cloudflare/workers-types" />
// Shared fixtures of the group action route tests: fixed ed25519 test keys, Conway transactions
// written byte by byte around a library payload, witness sets signed over the body hash, seeded
// engine state and a direct call of a route handler.
import { ed25519 } from '@noble/curves/ed25519.js';
import { Ed25519Signature, TransactionWitnessSet, VKey } from '@evolution-sdk/evolution';
import { env as workerEnv } from 'cloudflare:workers';
import { type Credential, encodePayload, type GroupEvent, majorityScript, type PayloadInput } from 'drep-groups';
import { blake2b224, blake2b256 } from '@/lib/crypto/blake';
import { encodeBech32 } from '@/lib/crypto/bech32';
import { bytesToHex, hexToBytes } from '@/lib/crypto/hex';
import { ENGINE_BUDGET } from '@/lib/groups/constants';
import { drepIdForCredential } from '@/lib/groups/ids';
import { type Cbor, cbor, deliver, type Input, labelTx, ledgerRow, settle } from '@/lib/groups/__tests__/loadFixtures';
import { acquireLease, invocationOwner } from '@/lib/groups/store/lease';

// The test bindings, read through the runtime module so the type check of this helper needs no test types.
const env = { DB: workerEnv.DB as D1Database };

export interface TestKey {
  priv: Uint8Array;
  pub: Uint8Array;
  hash: string;
  drepId: string;
}

export function testKey(n: number): TestKey {
  const priv = hexToBytes(n.toString(16).padStart(2, '0').repeat(32));
  const pub = ed25519.getPublicKey(priv);
  const hash = bytesToHex(blake2b224(pub));
  return { priv, pub, hash, drepId: drepIdForCredential({ kind: 'key', hash }) };
}

export const ALICE = testKey(1);
export const BOB = testKey(2);
export const CAROL = testKey(3);
export const DAVE = testKey(4);
export const ERIN = testKey(5);
/** The payment key of the initiator's wallet. */
export const PAY = testKey(9);

export const keyCred = (k: TestKey): Credential => ({ kind: 'key', hash: k.hash });

/** An enterprise testnet address paid to the key. */
export function enterpriseAddress(k: TestKey): { bytes: Uint8Array; bech32: string } {
  const bytes = Uint8Array.from([0x60, ...hexToBytes(k.hash)]);
  return { bytes, bech32: encodeBech32('addr_test', bytes) };
}

export const FEE_INPUT = { txHash: 'f1'.repeat(32), index: 0 };
export const TIP_SLOT = 1_000_000;
export const TTL = TIP_SLOT + 172_800;

export interface TxParts {
  payload: PayloadInput | Uint8Array;
  requiredSigners?: string[];
  invalidHereafter?: number | null;
  invalidBefore?: number;
  inputs?: Array<{ txHash: string; index: number }>;
  /** Metadata attached instead of the one the body commits to. */
  swapAux?: Uint8Array;
  /** Extra body entries, for example certificates (4) or votes (19). */
  extraBody?: Array<[number, Cbor]>;
}

const auxOf = (payloadBytes: Uint8Array): Uint8Array => Uint8Array.from([0xa1, ...cbor(8416), ...payloadBytes]);

/** A Conway transaction around the payload, the metadata hash in the body, no witnesses. */
export function buildTx(p: TxParts): { hex: string; bodyHash: string; bytes: Uint8Array } {
  const payloadBytes = p.payload instanceof Uint8Array ? p.payload : encodePayload(p.payload);
  const aux = auxOf(payloadBytes);
  const body = new Map<number, Cbor>([
    [0, (p.inputs ?? [FEE_INPUT]).map((i) => [hexToBytes(i.txHash), i.index])],
    [1, [[enterpriseAddress(PAY).bytes, 5_000_000]]],
    [2, 200_000],
  ]);
  const ttl = p.invalidHereafter === undefined ? TTL : p.invalidHereafter;
  if (ttl !== null) body.set(3, ttl);
  body.set(7, blake2b256(aux));
  if (p.invalidBefore !== undefined) body.set(8, p.invalidBefore);
  if (p.requiredSigners?.length) body.set(14, p.requiredSigners.map((k) => hexToBytes(k)));
  for (const [k, v] of p.extraBody ?? []) body.set(k, v);
  const bodyBytes = cbor(body);
  const bytes = Uint8Array.from([0x84, ...bodyBytes, 0xa0, 0xf5, ...(p.swapAux ?? aux)]);
  return { hex: bytesToHex(bytes), bodyHash: bytesToHex(blake2b256(bodyBytes)), bytes };
}

/** A metadata item carrying the payload under the group label. */
export const auxFor = (payload: PayloadInput): Uint8Array => auxOf(encodePayload(payload));

/** A witness set with one vkey witness per key, each signing the body hash. */
export function witnessSet(bodyHash: string, ...keys: TestKey[]): string {
  const ws = TransactionWitnessSet.fromVKeyWitnesses(
    keys.map(
      (k) =>
        new TransactionWitnessSet.VKeyWitness({
          vkey: VKey.fromBytes(k.pub),
          signature: Ed25519Signature.fromBytes(ed25519.sign(hexToBytes(bodyHash), k.priv)),
        }),
    ),
  );
  return TransactionWitnessSet.toCBORHex(ws);
}

// One owner for the whole file, so a later seed renews the lease of an earlier one.
const OWNER = invocationOwner();
export const lease = async (): Promise<string> => (await acquireLease(env.DB, OWNER)) as string;

/** A label tx at height n with the payload, signed by the keys. */
export const groupTx = (n: number, payload: PayloadInput, signers: TestKey[]): Input => ({
  tx: labelTx(n, n, { payload: encodePayload(payload), rs: signers.map((k) => k.hash), wk: signers.map((k) => k.hash) }),
});
export const reg = (n: number, k: TestKey): Input => ({ ledger: ledgerRow(n, n, keyCred(k), 'reg') });

export async function seed(inputs: Input[], top: number): Promise<void> {
  const l = await lease();
  await deliver(env.DB, l, inputs, top);
  await settle(env.DB, l, ENGINE_BUDGET);
}

const txHex = (n: number): string => n.toString(16).padStart(64, '0');

/** A permissioned group at 10 managed by Alice, admission by Bob, with Carol's request to join at 30. */
export const PERM = {
  ref: { txHash: txHex(10), index: 0 },
  control: majorityScript([ALICE.hash], 1),
  admission: majorityScript([BOB.hash], 1),
  carolJoin: `${txHex(30)}#0`,
};

export async function seedPermissioned(extra: Input[] = [], top = 40): Promise<void> {
  const create: GroupEvent = { tag: 'create', mode: 'permissioned', control: PERM.control.hash, admission: PERM.admission.hash, profile: null };
  await seed(
    [
      reg(5, ALICE),
      reg(6, BOB),
      groupTx(10, { events: [create], scripts: [PERM.control.script, PERM.admission.script] }, [ALICE, BOB]),
      reg(20, CAROL),
      groupTx(30, { events: [{ tag: 'join', group: PERM.ref, member: keyCred(CAROL) }] }, [CAROL]),
      reg(40, DAVE),
      ...extra,
    ],
    top,
  );
}

/** An open group at 10 managed by Alice alone, Alice its only member. */
export const SOLO = {
  ref: { txHash: txHex(10), index: 0 },
  control: majorityScript([ALICE.hash], 1),
};

export async function seedSolo(): Promise<void> {
  await seed(
    [
      reg(5, ALICE),
      groupTx(
        10,
        {
          events: [
            { tag: 'create', mode: 'open', control: SOLO.control.hash, admission: null, profile: null },
            { tag: 'join', group: { local: 0 }, member: keyCred(ALICE) },
          ],
          scripts: [SOLO.control.script],
        },
        [ALICE],
      ),
    ],
    20,
  );
}

export type SessionUser = { id: string; roles: string[]; drepId?: string | null } | null;

export const sessionOf = (id: string, k: TestKey, role = 'drep'): SessionUser => ({ id, roles: [role], drepId: k.drepId });

export async function seedUser(id: string, drepId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, drep_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, 1, 0, 0, 0, 'drep', 'active', 1, 1)`,
  )
    .bind(id, drepId)
    .run();
}

type Handler = (ctx: never) => Promise<Response> | Response;

/** Calls a route handler with a synthetic context. */
export async function call<T = Record<string, unknown>>(
  handler: Handler,
  user: SessionUser,
  opts: { id?: string; body?: unknown; method?: string } = {},
): Promise<{ status: number; json: T }> {
  const request = new Request(`https://dreptalk.com/api/groups/actions/${opts.id ?? ''}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', origin: 'https://dreptalk.com', 'cf-connecting-ip': '203.0.113.9' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const ctx = { request, locals: { user } as unknown as App.Locals, params: opts.id === undefined ? {} : { id: opts.id } };
  const res = await handler(ctx as never);
  return { status: res.status, json: (await res.json()) as T };
}
