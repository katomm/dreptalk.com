/// <reference types="@cloudflare/workers-types" />
// Group rows of the signing table: storing a new action together with the one open control action
// check, reading and freeing a group's control slot, cancelling, and deleting old resolved rows.
import type { GroupActionKind, PendingMultisigRow } from '../db/pendingMultisigTx.js';
import type { GroupIntent } from './actions.js';
import type { OutRef } from './groupTx.js';
import { ACTION_TTL_SECONDS, GROUP_ACTION_PRUNE_PER_RUN, GROUP_ACTION_RETENTION_MS, OPEN_INPUT_ROWS } from './constants.js';
import { Q } from './store/queries.js';

export interface NewGroupAction {
  id: string;
  kind: GroupActionKind;
  subjectKind: 'member' | 'group';
  subjectId: string;
  intent: GroupIntent;
  nativeScriptJson: string;
  unsignedTxCbor: string;
  bodyHash: string;
  requiredSigners: string[];
  invalidHereafter: number;
  feeInputs: Array<{ txHash: string; index: number }>;
  /** Payment key hashes of the fee input addresses. */
  feePayKeys: string[];
  eventCount: number;
  controlSlot: boolean;
  profileHash: string | null;
  createdBy: string;
  now: number;
}

/**
 * Stores the action as collecting, expiring ACTION_TTL_SECONDS from now. A control action is stored
 * only while its group has no open control action, decided in the same statement.
 */
export async function createGroupAction(db: D1Database, rec: NewGroupAction): Promise<'created' | 'slot taken'> {
  const res = await db
    .prepare(Q.actionCreate.sql)
    .bind(
      rec.id,
      rec.subjectId,
      rec.kind,
      JSON.stringify(rec.intent),
      rec.unsignedTxCbor,
      rec.bodyHash.toLowerCase(),
      rec.nativeScriptJson,
      rec.createdBy,
      rec.now,
      rec.now + ACTION_TTL_SECONDS,
      rec.subjectKind,
      JSON.stringify(rec.requiredSigners.map((k) => k.toLowerCase())),
      rec.invalidHereafter,
      JSON.stringify(rec.feeInputs),
      rec.eventCount,
      rec.profileHash?.toLowerCase() ?? null,
      rec.controlSlot ? 1 : 0,
      JSON.stringify([...new Set(rec.feePayKeys.map((k) => k.toLowerCase()))].sort()),
    )
    .run();
  return (res.meta.changes ?? 0) > 0 ? 'created' : 'slot taken';
}

/** The row holding the group's control slot, null when the slot is free. */
export async function openControlAction(db: D1Database, groupId: string): Promise<PendingMultisigRow | null> {
  return (await db.prepare(Q.actionOpenControl.sql).bind(groupId).first<PendingMultisigRow>()) ?? null;
}

/**
 * Frees the slot of a control row whose seq is stale: it resolves failed and stays closed. `now` is
 * in seconds like the other signing columns, resolved_at is written in milliseconds.
 */
export async function freeStaleSlot(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare(Q.actionFreeStale.sql).bind(id, now, now * 1000).run();
}

/**
 * Deletes group and member rows resolved more than GROUP_ACTION_RETENTION_MS before `now` (in
 * milliseconds), at most GROUP_ACTION_PRUNE_PER_RUN per call, and returns how many went.
 */
export async function pruneResolvedGroupActions(db: D1Database, now: number): Promise<number> {
  const res = await db.prepare(Q.actionPruneResolved.sql).bind(now - GROUP_ACTION_RETENTION_MS, GROUP_ACTION_PRUNE_PER_RUN).run();
  return res.meta.changes ?? 0;
}

/** Cancels a collecting row. The slot stays held, handed out witnesses stay usable until expiry. */
export async function cancelGroupAction(db: D1Database, id: string, now: number): Promise<boolean> {
  const res = await db.prepare(Q.actionCancel.sql).bind(id, now).run();
  return (res.meta.changes ?? 0) > 0;
}

/** An open group row with the wallet outputs its transaction spends. */
export interface OpenInputs {
  id: string;
  createdBy: string;
  feeInputs: OutRef[];
}

const outRefKey = (r: OutRef): string => `${r.txHash.toLowerCase()}#${r.index}`;

function feeInputsOf(raw: unknown): OutRef[] {
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v)
      ? v.flatMap((x: { txHash?: unknown; index?: unknown }) =>
          typeof x?.txHash === 'string' && Number.isInteger(x.index) ? [{ txHash: x.txHash.toLowerCase(), index: Number(x.index) }] : [],
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * The open group rows, collecting or submitted and not resolved, with their fee inputs. Their
 * transactions may still reach the chain, so no new action may spend the same outputs. A
 * cancelled row is left out, its initiator chose to let it go.
 */
export async function openActionInputs(db: D1Database): Promise<OpenInputs[]> {
  const res = await db.prepare(Q.actionOpenInputs.sql).bind(OPEN_INPUT_ROWS).all<Record<string, unknown>>();
  return (res.results ?? []).map((r) => ({ id: String(r.id), createdBy: String(r.created_by), feeInputs: feeInputsOf(r.fee_inputs) }));
}

/** The first open row that spends any of the inputs, null when none does. */
export function actionHoldingInputs(open: readonly OpenInputs[], inputs: readonly OutRef[]): OpenInputs | null {
  const wanted = new Set(inputs.map(outRefKey));
  return open.find((o) => o.feeInputs.some((f) => wanted.has(outRefKey(f)))) ?? null;
}

/** The fee inputs the user's own open rows hold, each once. */
export function inputsHeldBy(open: readonly OpenInputs[], userId: string): OutRef[] {
  const out = new Map<string, OutRef>();
  for (const o of open) if (o.createdBy === userId) for (const f of o.feeInputs) out.set(outRefKey(f), f);
  return [...out.values()];
}
