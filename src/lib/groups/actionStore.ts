/// <reference types="@cloudflare/workers-types" />
// Group rows of the signing table: storing a new action together with the one open control action
// check, reading and freeing a group's control slot, and cancelling.
import type { GroupActionKind, PendingMultisigRow } from '../db/pendingMultisigTx.js';
import type { GroupIntent } from './actions.js';
import { ACTION_TTL_SECONDS } from './constants.js';
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

/** Frees the slot of a control row whose seq is stale: it resolves failed and stays closed. */
export async function freeStaleSlot(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare(Q.actionFreeStale.sql).bind(id, now).run();
}

/** Cancels a collecting row. The slot stays held, handed out witnesses stay usable until expiry. */
export async function cancelGroupAction(db: D1Database, id: string, now: number): Promise<boolean> {
  const res = await db.prepare(Q.actionCancel.sql).bind(id, now).run();
  return (res.meta.changes ?? 0) > 0;
}
