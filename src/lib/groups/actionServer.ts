/// <reference types="@cloudflare/workers-types" />
// Server side of the group signing link, shared by the action routes: the session's keys, a stored
// row with its intent, decoded transaction and the current group state, the staleness checks
// before every witness and submit, display names and signature request notifications. The
// transaction codec lives in actionTx.ts.
import { type Credential, collectKeyHashes, EncodeError, type EventRef, type GroupEvent, type NativeScript, refKey } from 'drep-groups';
import { z } from 'zod';
import { currentNetwork, jsonResponse, runtimeEnv } from '../api/response.js';
import { sessionKeyHash } from '../auth/groupSigner.js';
import { GROUP_SIGNER_ROLE } from '../auth/roles.js';
import { profileAround } from '../db/drepGroups.js';
import { insertGroupNotifications } from '../db/groupNotifications.js';
import { getPendingMultisig, type PendingMultisigRow, type PendingWitness } from '../db/pendingMultisigTx.js';
import { createKoiosClient } from '../koios/client.js';
import { checkRate } from '../rate.js';
import { freeStaleSlot } from './actionStore.js';
import { controlSeq, type DecodedGroupTx, decodeGroupTx, eventsOf, paymentKeyHash } from './actionTx.js';
import { ACTION_RATE } from './constants.js';
import { drepGroupsAvailable } from './gate.js';
import { changesOfEvents, type GroupIntent, type GroupState, IntentError, maySign, parseJoinRef, signerSetSatisfies } from './actions.js';
import { hashBytes, scriptDisplayJson, scriptFromDisplayJson } from './codec.js';
import { describeAction, type GroupChanges } from './describe.js';
import { credentialForDrepId, drepIdForCredential, groupIdParam } from './ids.js';
import { noKeys, PreviewUnavailable, readGroupState } from './preview.js';
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
      // A group is founded with its profile anchor.
      profile: anchor,
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
  /** Payment key hashes of the fee input addresses, stored with the row. */
  feePayKeys: Set<string>;
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
    feePayKeys: new Set(JSON.parse(row.fee_pay_keys ?? '[]') as string[]),
  };
}

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
 * The payment key hashes of the fee input addresses, and whether any fee input is spent or
 * unknown to Koios.
 */
export async function feeInputKeys(
  koios: Pick<GroupKoios, 'utxoInfo'>,
  feeInputs: Array<{ txHash: string; index: number }>,
): Promise<{ payKeys: Set<string>; spent: boolean }> {
  const utxos = await koios.utxoInfo(feeInputs);
  const byRef = new Map(utxos.map((u) => [`${u.txHash.toLowerCase()}#${u.index}`, u]));
  const payKeys = new Set<string>();
  let spent = false;
  for (const f of feeInputs) {
    const u = byRef.get(`${f.txHash}#${f.index}`);
    if (!u || u.isSpent) spent = true;
    else {
      const k = paymentKeyHash(u.address);
      if (k) payKeys.add(k);
    }
  }
  return { payKeys, spent };
}

/**
 * Why the collected witnesses cannot be submitted yet, null when they can: every required signer
 * signed, every key payment credential of the fee inputs signed in any role, and the signers
 * satisfy the action. Shared by submit and the signing page.
 */
export function submitBlocker(ctx: GroupRowContext, payKeys: Set<string>): string | null {
  const signed = new Set(witnessKeys(ctx.witnesses));
  if (!ctx.requiredSigners.every((k) => signed.has(k))) return 'not every required signer has signed';
  // The fee inputs spend from the initiator's wallet, each of its payment keys must have signed.
  if (payKeys.size === 0 || ![...payKeys].every((k) => signed.has(k))) return 'funding signature missing';
  if (!collectedSatisfy(ctx)) return 'the signatures do not satisfy the action';
  return null;
}

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
  if (row.invalid_hereafter === null || tip.abs_slot >= row.invalid_hereafter) return no(410, 'expired');
  const fee = await feeInputKeys(koios, ctx.feeInputs);
  if (fee.spent) return no(409, 'fee input spent');
  const payKeys = ctx.feePayKeys.size > 0 ? ctx.feePayKeys : fee.payKeys;
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

/**
 * DRep names by credential hash, and the member of every join reference the events name, for the
 * plain words of the events. A member without a DRep name is worded by its DRep id.
 */
export async function namesFor(
  db: D1Database,
  keyHashes: string[],
  events: GroupEvent[],
): Promise<{ names: Map<string, string>; joinMembers: Map<string, Credential> }> {
  const creds = new Map<string, Credential>(keyHashes.map((h) => [h.toLowerCase(), { kind: 'key', hash: h.toLowerCase() }]));
  for (const e of events) if (e.tag === 'join') creds.set(e.member.hash.toLowerCase(), e.member);
  const joinRefs = events.flatMap((e) => ('join' in e && !('local' in e.join) ? [e.join] : []));
  const insts = joinRefs.length > 0 ? await instancesOf(db, joinRefs) : new Map();
  const joinMembers = new Map<string, Credential>();
  for (const [ref, i] of insts) {
    if (!i) continue;
    creds.set(i.member.hash.toLowerCase(), i.member);
    joinMembers.set(ref, i.member);
  }

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
  return { names, joinMembers };
}

/** The profile before and after the update of a transaction's events that sets a new anchor, see profileAround. */
async function profileChangeOf(db: D1Database, group: EventRef | null, events: GroupEvent[]): Promise<GroupChanges['profile'] | undefined> {
  const anchor = events.flatMap((e) => (e.tag === 'update' && e.changes.profile ? [e.changes.profile] : []))[0];
  return anchor ? profileAround(db, group, anchor.dataHash.toLowerCase()) : undefined;
}

/**
 * The plain words of a transaction's events for the signing page and the signature request:
 * members and policy keys by DRep name, policy changes from the current policy, profile changes
 * by field. Also returns the DRep names it read, by key or credential hash.
 */
export async function describeTxNamed(
  db: D1Database,
  o: { events: GroupEvent[]; state: GroupState | null; scripts: ReadonlyArray<{ hash: string; script: NativeScript }>; signers: string[] },
): Promise<{ lines: string[]; names: Map<string, string> }> {
  const keys = [
    ...o.signers,
    ...o.scripts.flatMap((s) => collectKeyHashes(s.script)),
    ...(o.state ? [...collectKeyHashes(o.state.control), ...(o.state.admission ? collectKeyHashes(o.state.admission) : [])] : []),
  ];
  const [{ names, joinMembers }, profile] = await Promise.all([
    namesFor(db, keys, o.events),
    profileChangeOf(db, o.state?.ref ?? null, o.events),
  ]);
  const changes = changesOfEvents(o.events, o.state, o.scripts, { joinMembers, ...(profile ? { profile } : {}) });
  return { lines: describeAction(changes, names), names };
}

/** Plain words of the row's events. */
export async function linesOf(db: D1Database, ctx: GroupRowContext): Promise<string[]> {
  return (await describeTxNamed(db, { events: eventsOf(ctx.tx.decoded), state: ctx.state, scripts: ctx.tx.decoded?.scripts ?? [], signers: ctx.requiredSigners })).lines;
}

/**
 * Signature requests to the accounts of the signers, except the initiator. A failure is logged,
 * the signing link exists regardless.
 */
export async function notifySigners(
  db: D1Database,
  o: { rowId: string; groupId: string; group: EventRef | null; signers: string[]; initiator: string; initiatorName: string | null; summary: string },
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
        payload: { groupId: o.groupId, groupName, actionId: o.rowId, summary: o.summary, ...(o.initiatorName ? { memberName: o.initiatorName } : {}) },
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
 * The common start of every row route: a network where DRep groups run, a signed in session, a group row (404 for
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
  let ctx: GroupRowContext | null;
  try {
    ctx = await loadGroupRow(db, id);
  } catch (err) {
    console.error(`[drep-groups] signing row ${id} could not be read`, err);
    return jsonResponse({ error: err instanceof PreviewUnavailable ? err.message : 'service unavailable' }, 503);
  }
  if (!ctx) return jsonResponse({ error: 'not found' }, 404);
  // A control or admission row whose group the store no longer holds cannot be judged.
  if (ctx.intent.kind !== 'group_create' && !ctx.state) return jsonResponse({ error: 'group state unavailable' }, 409);
  const session = sessionOf(user);
  if (!rowMaySign(ctx, session)) return jsonResponse({ error: 'not a signer of this action' }, 403);
  return { db, env, user, session, ctx };
}

export function koiosFor(env: Cloudflare.Env): ReturnType<typeof createKoiosClient> {
  const { koiosBaseUrl } = currentNetwork();
  return createKoiosClient({ baseUrl: koiosBaseUrl, token: (env.KOIOS_API_KEY as string | undefined) || undefined });
}

/** Rate limit of the Koios backed checks of the row routes, per user. The refusal, null when allowed. */
export async function rowRateRefusal(env: Cloudflare.Env, userId: string): Promise<Response | null> {
  const limiter = env.RATE_LIMITER;
  if (!limiter) return jsonResponse({ error: 'service unavailable' }, 503);
  const ok = await checkRate(limiter, `group-action-check:${userId}`, { ...ACTION_RATE, now: Date.now() });
  return ok ? null : jsonResponse({ error: 'rate_limited' }, 429);
}

/** Key hashes with a stored witness of the role, all roles without one. */
export const witnessKeys = (ws: PendingWitness[], role?: PendingWitness['role']): string[] =>
  ws.filter((w) => role === undefined || (w.role ?? 'signer') === role).map((w) => w.key_hash);

/**
 * True when the collected signers satisfy every needed policy and every required signer signed. A
 * key that resigned from a role counts toward that role's policy for nothing.
 */
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
