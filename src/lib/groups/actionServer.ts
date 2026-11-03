/// <reference types="@cloudflare/workers-types" />
// Server side of the group signing link, shared by the action routes: the session's keys, the
// decoded transaction, a stored row with its intent and the current group state, the staleness
// checks before every witness and submit, display names and signature request notifications.
import { Ed25519Signature, Transaction, TransactionBody, TransactionHash, TransactionWitnessSet, VKey } from '@evolution-sdk/evolution';
import {
  type ChainTx,
  type Credential,
  type DecodedPayload,
  decodePayload,
  decodeTransaction,
  EncodeError,
  type EventRef,
  type GroupEvent,
  inspectTransaction,
  type Keys,
  type NativeScript,
  refKey,
  type TxFacts,
} from 'drep-groups';
import { z } from 'zod';
import { currentNetwork, jsonResponse, runtimeEnv } from '../api/response.js';
import { sessionKeyHash } from '../auth/groupSigner.js';
import { GROUP_SIGNER_ROLE } from '../auth/roles.js';
import { decodeBech32 } from '../crypto/bech32.js';
import { bytesToHex, hexToBytes } from '../crypto/hex.js';
import { insertGroupNotifications } from '../db/groupNotifications.js';
import { getPendingMultisig, type PendingMultisigRow, type PendingWitness } from '../db/pendingMultisigTx.js';
import { createKoiosClient } from '../koios/client.js';
import { parseWitnessSetHex } from '../governance/multisigWitness.js';
import { checkRate } from '../rate.js';
import { freeStaleSlot } from './actionStore.js';
import { ACTION_RATE } from './constants.js';
import { drepGroupsAvailable } from './gate.js';
import { describeEvents, type GroupIntent, type GroupState, IntentError, maySign, parseJoinRef, signerSetSatisfies } from './actions.js';
import { hashBytes, scriptDisplayJson, scriptFromDisplayJson } from './codec.js';
import { credentialForDrepId, drepIdForCredential, groupIdParam } from './ids.js';
import { readGroupState } from './preview.js';
import { txProgress } from './resolve.js';
import { KEYED, KEYED_WIDTH, OWN, OWN_WIDTH, Q } from './store/queries.js';
import { load } from './store/reads.js';
import { keyedStatements } from './store/recovery.js';

export type GroupKoios = Pick<ReturnType<typeof createKoiosClient>, 'tip' | 'utxoInfo' | 'drepInfo' | 'scriptInfo'>;

export interface Session {
  keyHash: string | null;
  drepId: string | null;
}

/** The key hash and the DRep id a session acts with. */
export function sessionOf(user: NonNullable<App.Locals['user']>): Session {
  const dreplike = user.roles.includes('drep') || user.roles.includes(GROUP_SIGNER_ROLE);
  return { keyHash: sessionKeyHash(user), drepId: dreplike ? (user.drepId ?? null) : null };
}

// Intent shapes as the client sends them. Hashes are lowercased by the action module.
const KEY_HASH = z.string().regex(/^[0-9a-fA-F]{56}$/);
const majority = z.object({ keys: z.array(KEY_HASH).min(1).max(64), n: z.number().int().min(1).max(64) }).strict();
const anchor = z.object({ url: z.string().min(1).max(128), dataHash: z.string().regex(/^[0-9a-fA-F]{64}$/) }).strict();
const drepId = z.string().min(1).max(120);
const groupId = z.string().min(1).max(120);
const joinRef = z.string().regex(/^[0-9a-fA-F]{64}#\d{1,5}$/);

export const intentSchema: z.ZodType<GroupIntent> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('group_create'),
      mode: z.enum(['open', 'permissioned']),
      control: majority,
      admission: z.union([majority, z.literal('same'), z.null()]),
      founders: z.array(drepId).min(1).max(63),
      profile: anchor.nullable(),
    })
    .strict(),
  z.object({ kind: z.enum(['group_join', 'group_leave']), group: groupId, member: drepId, join: joinRef.optional() }).strict(),
  z.object({ kind: z.enum(['group_approve', 'group_remove']), group: groupId, joins: z.array(joinRef).min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal('group_update'),
      group: groupId,
      approvals: z.array(joinRef).max(63),
      control: majority.optional(),
      admission: z.union([majority, z.literal('same')]).optional(),
      profile: anchor.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('group_dissolve'), group: groupId }).strict(),
]) as unknown as z.ZodType<GroupIntent>;

export interface DecodedGroupTx {
  bytes: Uint8Array;
  facts: TxFacts;
  chain: ChainTx;
  decoded: DecodedPayload | null;
  /** Lowercase hex blake2b-256 of the body bytes as they are, the tx hash. */
  bodyHash: string;
  inputs: Array<{ txHash: string; index: number }>;
}

/** Decodes an unsigned group transaction. Throws on anything that is not a well formed Conway transaction. */
export function decodeGroupTx(hex: string): DecodedGroupTx {
  const bytes = hexToBytes(hex);
  const facts = inspectTransaction(bytes);
  const tx = Transaction.fromCBORHex(hex);
  // The hash of the original body bytes, a re-encoded body could hash differently.
  const bodyHash = TransactionHash.toHex(TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(bytes))).toLowerCase();
  const chain = decodeTransaction(bytes, { txHash: bodyHash, blockHeight: 0, txIndex: 0 });
  if (chain.invalidHereafter !== (tx.body.ttl ?? null)) throw new Error('validity end read differently');
  const inputs = tx.body.inputs.map((i) => ({ txHash: TransactionHash.toHex(i.transactionId).toLowerCase(), index: Number(i.index) }));
  return { bytes, facts, chain, decoded: chain.payload ? decodePayload(chain.payload) : null, bodyHash, inputs };
}

// The empty witness set of an unsigned DRepTalk group transaction, no scripts attached.
const EMPTY_WITNESS_SET = 0xa0;

/** True when the unsigned transaction carries an empty witness set right after its body. */
export function hasEmptyWitnessSet(tx: DecodedGroupTx): boolean {
  return tx.bytes[1 + Transaction.extractBodyBytes(tx.bytes).length] === EMPTY_WITNESS_SET;
}

/**
 * The unsigned transaction with the stored vkey witnesses in its witness set. The body and the
 * metadata bytes are kept as they are, so the tx hash stays the body hash the witnesses signed.
 */
export function assembleTx(unsignedHex: string, witnesses: PendingWitness[]): string {
  const bytes = hexToBytes(unsignedHex);
  const bodyEnd = 1 + Transaction.extractBodyBytes(bytes).length;
  if (bytes[bodyEnd] !== EMPTY_WITNESS_SET) throw new Error('unsigned transaction carries witnesses');
  const vkeys = witnesses.flatMap((w) =>
    parseWitnessSetHex(w.witness_hex).map(
      (p) =>
        new TransactionWitnessSet.VKeyWitness({
          vkey: VKey.fromBytes(hexToBytes(p.vkeyHex)),
          signature: Ed25519Signature.fromBytes(hexToBytes(p.signatureHex)),
        }),
    ),
  );
  const set = hexToBytes(TransactionWitnessSet.toCBORHex(TransactionWitnessSet.fromVKeyWitnesses(vkeys)));
  return bytesToHex(Uint8Array.from([...bytes.subarray(0, bodyEnd), ...set, ...bytes.subarray(bodyEnd + 1)]));
}

export const isControlKind = (kind: GroupIntent['kind']): boolean => kind === 'group_update' || kind === 'group_dissolve';

/** The DRep members a payload's joins and leaves name, whose registration and scripts Koios answers. */
export function payloadMembers(intent: GroupIntent): Credential[] {
  const ids = intent.kind === 'group_create' ? intent.founders : intent.kind === 'group_join' || intent.kind === 'group_leave' ? [intent.member] : [];
  return ids.flatMap((id) => {
    const c = credentialForDrepId(id);
    return c ? [{ kind: c.kind, hash: c.hash.toLowerCase() }] : [];
  });
}

/** Display JSON of a policy, without the hash the state attaches. */
export const policyJson = (p: NativeScript): string => scriptDisplayJson({ ...p, hash: undefined } as unknown as NativeScript);

/** The seq of the control event of a payload, null without one. */
export function controlSeq(decoded: DecodedPayload | null): bigint | null {
  for (const e of decoded?.events ?? []) {
    if (e.ok && (e.event.tag === 'update' || e.event.tag === 'dissolve')) return e.event.seq;
  }
  return null;
}

/** The payment key hash of a Shelley address, null for a script payment credential or anything else. */
export function paymentKeyHash(address: string): string | null {
  try {
    const { prefix, data } = decodeBech32(address);
    if (prefix !== 'addr' && prefix !== 'addr_test') return null;
    const type = data[0] >> 4;
    if (type > 7 || type % 2 !== 0 || data.length < 29) return null;
    return bytesToHex(data.subarray(1, 29));
  } catch {
    return null;
  }
}

export interface GroupRowContext {
  row: PendingMultisigRow;
  intent: GroupIntent;
  /** Null for a create, and for a group the store does not hold. */
  state: GroupState | null;
  memberScript: NativeScript | null;
  tx: DecodedGroupTx;
  witnesses: PendingWitness[];
  requiredSigners: string[];
  feeInputs: Array<{ txHash: string; index: number }>;
}

/** A group signing row with its intent and the current state of its group, null for any other row. */
export async function loadGroupRow(db: D1Database, id: string): Promise<GroupRowContext | null> {
  const row = await getPendingMultisig(db, id);
  if (!row || (row.subject_kind !== 'member' && row.subject_kind !== 'group') || row.action === 'vote') return null;
  const intent = JSON.parse(row.action_params) as GroupIntent;
  let state: GroupState | null = null;
  if (intent.kind !== 'group_create') {
    const ref = groupIdParam(intent.group);
    if (!ref) throw new Error(`signing row ${id} names a bad group`);
    state = await readGroupState(db, ref);
  }
  const member = intent.kind === 'group_join' || intent.kind === 'group_leave' ? credentialForDrepId(intent.member) : null;
  return {
    row,
    intent,
    state,
    memberScript: member?.kind === 'script' ? scriptFromDisplayJson(row.native_script) : null,
    tx: decodeGroupTx(row.unsigned_tx_cbor),
    witnesses: JSON.parse(row.witnesses) as PendingWitness[],
    requiredSigners: JSON.parse(row.required_signers ?? '[]') as string[],
    feeInputs: JSON.parse(row.fee_inputs ?? '[]') as Array<{ txHash: string; index: number }>,
  };
}

const noKeys = (): Keys => ({ instances: [], latestInstances: [], groupsAt: [], scriptsAt: [], credentialAt: [] });

/** The stored instance of each join, absent when the store does not hold it. */
async function instancesOf(db: D1Database, refs: EventRef[]) {
  const view = await load(db, { ...noKeys(), instances: refs }, []);
  return new Map(refs.map((r) => [refKey(r), view.instance(r)] as const));
}

/** Open join references of the member in the group, for a leave that names no join. */
export async function openJoinsOf(db: D1Database, group: EventRef, member: Credential): Promise<Map<string, Credential>> {
  const inst = (await load(db, { ...noKeys(), latestInstances: [[group, member]] }, [])).latestInstance(group, member);
  return inst && inst.closedAt === null ? new Map([[refKey(inst.joinId), inst.member]]) : new Map();
}

export type Refusal = { status: number; error: string };

/**
 * Frees the control slot of a row whose seq went stale. A row whose own tx the store already
 * holds is left to the resolver, its outcomes decide.
 */
export async function releaseStaleSlot(db: D1Database, row: PendingMultisigRow, now: number): Promise<void> {
  if (row.control_slot !== 1) return;
  if ((await txProgress(db, [row.body_hash])).get(row.body_hash)?.height != null) return;
  await freeStaleSlot(db, row.id, now);
}

/**
 * The checks before every witness and submit: collecting, not past its validity end, every fee
 * input unspent, the group's seq unchanged for a control action (else its slot is freed), the
 * admission policy unchanged for an approval or removal, and every target request still in a
 * state the action can act on. Gives the payment key hashes of the fee input addresses.
 */
export async function checkFresh(
  db: D1Database,
  koios: GroupKoios,
  ctx: GroupRowContext,
  now: number,
): Promise<{ ok: true; payKeys: Set<string> } | ({ ok: false } & Refusal)> {
  const { row, intent, state } = ctx;
  const no = (status: number, error: string) => ({ ok: false as const, status, error });
  if (row.status !== 'collecting') return no(409, 'no longer collecting');
  const tip = await koios.tip();
  if (row.invalid_hereafter === null || tip.abs_slot > row.invalid_hereafter) return no(410, 'expired');
  const utxos = await koios.utxoInfo(ctx.feeInputs);
  const byRef = new Map(utxos.map((u) => [`${u.txHash.toLowerCase()}#${u.index}`, u]));
  const payKeys = new Set<string>();
  for (const f of ctx.feeInputs) {
    const u = byRef.get(`${f.txHash}#${f.index}`);
    if (!u || u.isSpent) return no(409, 'fee input spent');
    const k = paymentKeyHash(u.address);
    if (k) payKeys.add(k);
  }
  if (intent.kind === 'group_create') return { ok: true, payKeys };

  if (!state || state.status === 'dissolved' || (isControlKind(intent.kind) && controlSeq(ctx.tx.decoded) !== state.seq)) {
    await releaseStaleSlot(db, row, now);
    return no(409, 'stale');
  }
  if ((intent.kind === 'group_approve' || intent.kind === 'group_remove') && (!state.admission || policyJson(state.admission) !== row.native_script)) {
    return no(409, 'stale');
  }
  const approve = intent.kind === 'group_approve' ? intent.joins : intent.kind === 'group_update' ? intent.approvals : [];
  const remove = intent.kind === 'group_remove' ? intent.joins : [];
  const refs = [...approve, ...remove].map(parseJoinRef);
  if (refs.length > 0) {
    const insts = await instancesOf(db, refs);
    const pending = (j: string) => {
      const i = insts.get(refKey(parseJoinRef(j)));
      return !!i && i.closedAt === null && i.approvedAt === null;
    };
    const open = (j: string) => {
      const i = insts.get(refKey(parseJoinRef(j)));
      return !!i && i.closedAt === null;
    };
    if (!approve.every(pending) || !remove.every(open)) return no(409, 'stale');
  }
  return { ok: true, payKeys };
}

/** DRep names by credential hash, and member names by join reference, for the plain words of the events. */
export async function namesFor(db: D1Database, keyHashes: string[], events: GroupEvent[]): Promise<Map<string, string>> {
  const creds = new Map<string, Credential>(keyHashes.map((h) => [h.toLowerCase(), { kind: 'key', hash: h.toLowerCase() }]));
  for (const e of events) if (e.tag === 'join') creds.set(e.member.hash.toLowerCase(), e.member);
  const joinRefs = events.flatMap((e) => ('join' in e && !('local' in e.join) ? [e.join] : []));
  const insts = joinRefs.length > 0 ? await instancesOf(db, joinRefs) : new Map();
  for (const i of insts.values()) if (i) creds.set(i.member.hash.toLowerCase(), i.member);

  const byId = new Map([...creds.values()].map((c) => [drepIdForCredential(c), c.hash.toLowerCase()]));
  const names = new Map<string, string>();
  const stmts = keyedStatements(db, KEYED.drepNames, KEYED_WIDTH.drepNames, [...byId.keys()], (d) => [d]);
  if (stmts.length > 0) {
    for (const res of await db.batch<Record<string, unknown>>(stmts)) {
      for (const r of res.results ?? []) {
        const hash = byId.get(String(r.drep_id));
        if (hash) names.set(hash, String(r.name));
      }
    }
  }
  for (const [ref, i] of insts) {
    const n = i ? names.get(i.member.hash.toLowerCase()) : undefined;
    if (n) names.set(ref, n);
  }
  return names;
}

/** The events of a decoded payload that read, in order. */
export const eventsOf = (decoded: DecodedPayload | null): GroupEvent[] => (decoded?.events ?? []).flatMap((e) => (e.ok ? [e.event] : []));

/** Plain words of the row's events. */
export async function linesOf(db: D1Database, ctx: GroupRowContext): Promise<string[]> {
  const events = eventsOf(ctx.tx.decoded);
  const names = await namesFor(db, ctx.requiredSigners, events);
  return describeEvents(events, names, ctx.state, ctx.tx.decoded?.scripts ?? []);
}

/**
 * Signature requests to the accounts of the signers, except the initiator. A failure is logged,
 * the signing link exists regardless.
 */
export async function notifySigners(
  db: D1Database,
  o: { rowId: string; groupId: string; group: EventRef | null; signers: string[]; initiator: string; summary: string },
): Promise<void> {
  try {
    const dreps = o.signers.map((hash) => drepIdForCredential({ kind: 'key', hash }));
    const stmts = keyedStatements(db, OWN.notifyUsers, OWN_WIDTH.notifyUsers, dreps, (d) => [d]);
    const stmtsName = o.group ? [db.prepare(Q.actionGroupName.sql).bind(hashBytes(o.group.txHash), o.group.index)] : [];
    if (stmts.length === 0) return;
    const results = await db.batch<Record<string, unknown>>([...stmtsName, ...stmts]);
    const groupName = o.group ? ((results[0].results?.[0]?.name as string | undefined) ?? null) : null;
    const recipients = new Set(results.slice(stmtsName.length).flatMap((r) => (r.results ?? []).map((u) => String(u.id))));
    recipients.delete(o.initiator);
    await insertGroupNotifications(
      db,
      [...recipients].map((recipientId) => ({
        recipientId,
        type: 'group_signature_request' as const,
        eventKey: `group-sign:${o.rowId}`,
        payload: { groupId: o.groupId, groupName, actionId: o.rowId, summary: o.summary },
      })),
    );
  } catch (err) {
    console.error(`[drep-groups] signature requests for ${o.rowId} failed`, err);
  }
}

/** IntentError and the library's EncodeError describe an action that cannot be built. */
export const isIntentFailure = (err: unknown): boolean => err instanceof IntentError || err instanceof EncodeError;

/** Whether the session may open and sign the row. A group the store no longer holds lets nobody in. */
export function rowMaySign(ctx: GroupRowContext, session: Session): boolean {
  try {
    return maySign(ctx.intent, ctx.state, ctx.memberScript, session);
  } catch (err) {
    if (err instanceof IntentError) return false;
    throw err;
  }
}

export interface RowRequest {
  db: D1Database;
  env: Cloudflare.Env;
  user: NonNullable<App.Locals['user']>;
  session: Session;
  ctx: GroupRowContext;
}

/**
 * The common start of every row route: preprod only, a signed in session, a group row (404 for
 * any other row) and the signing gate. Returns the refusal as a response.
 */
export async function openRowRequest(locals: App.Locals, id: string | undefined): Promise<RowRequest | Response> {
  if (!drepGroupsAvailable(currentNetwork().network)) return jsonResponse({ error: 'not found' }, 404);
  const user = locals.user;
  if (!user) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!id) return jsonResponse({ error: 'not found' }, 404);
  const env = runtimeEnv(locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return jsonResponse({ error: 'service unavailable' }, 503);
  const ctx = await loadGroupRow(db, id);
  if (!ctx) return jsonResponse({ error: 'not found' }, 404);
  const session = sessionOf(user);
  if (!rowMaySign(ctx, session)) return jsonResponse({ error: 'not a signer of this action' }, 403);
  return { db, env, user, session, ctx };
}

export function koiosFor(env: Cloudflare.Env): ReturnType<typeof createKoiosClient> {
  const { koiosBaseUrl } = currentNetwork();
  return createKoiosClient({ baseUrl: koiosBaseUrl, token: (env.KOIOS_API_KEY as string | undefined) || undefined });
}

/** Rate limit of the Koios backed checks of the row routes, per user. */
export async function checkRowRate(env: Cloudflare.Env, userId: string): Promise<boolean> {
  const limiter = env.RATE_LIMITER;
  if (!limiter) return false;
  return checkRate(limiter, `group-action-check:${userId}`, { ...ACTION_RATE, now: Date.now() });
}

/** Key hashes with a stored witness of the role, all roles without one. */
export const witnessKeys = (ws: PendingWitness[], role?: PendingWitness['role']): string[] =>
  ws.filter((w) => role === undefined || (w.role ?? 'signer') === role).map((w) => w.key_hash);

/** True when the collected signers satisfy every needed policy and every required signer signed. */
export function collectedSatisfy(ctx: GroupRowContext): boolean {
  const signed = new Set(witnessKeys(ctx.witnesses));
  if (!ctx.requiredSigners.every((k) => signed.has(k))) return false;
  try {
    return signerSetSatisfies(ctx.state, ctx.intent, ctx.memberScript, [...signed], {
      invalidBefore: ctx.tx.chain.invalidBefore,
      invalidHereafter: ctx.tx.chain.invalidHereafter,
    });
  } catch (err) {
    if (err instanceof IntentError) return false;
    throw err;
  }
}
