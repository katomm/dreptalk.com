/// <reference types="@cloudflare/workers-types" />
// The join request drain after the engine runs of a tick. A queued permissioned join whose tx the engine has fully
// processed and which is still pending notifies the DRepTalk accounts of the key DReps in the group's admission
// policy. A join approved or closed by then, or whose instance is gone, is dropped without a notification.
import type { EventRef } from 'drep-groups';
import { collectKeyHashes, parseNativeScript, refKey } from 'drep-groups';
import { type GroupNotification, insertGroupNotifications, ROWS_PER_STATEMENT } from '../db/groupNotifications.js';
import { D1_MAX_BINDS } from '../db/sql.js';
import { bytesFromCol, refBinds, refFromCols, type Row } from './codec.js';
import { JOIN_NOTIFY_PER_TICK } from './constants.js';
import { drepIdForCredential, groupIdString } from './ids.js';
import { writeBatch } from './store/lease.js';
import { OWN, OWN_WIDTH, Q } from './store/queries.js';
import { keyedStatements } from './store/recovery.js';

/** Notification rows of one drain at most, the first join is always taken whole. */
const MAX_NOTIFY_ROWS = 100;

/**
 * Worst case D1 queries of one drain: the page, one account read (key DReps capped at the bind limit), the
 * notification batch and the delete batch.
 */
export const JOIN_NOTIFY_MAX_QUERIES =
  1 +
  1 +
  Math.ceil(MAX_NOTIFY_ROWS / ROWS_PER_STATEMENT) +
  2 +
  Math.ceil(JOIN_NOTIFY_PER_TICK / Math.floor(D1_MAX_BINDS / OWN_WIDTH.deleteJoinNotify));

interface PendingJoin {
  join: EventRef;
  groupId: string;
  groupName: string | null;
  memberName: string | null;
  dreps: string[];
}

/** Key DRep ids of the `sig` leaves of a stored policy, none when the script is missing or does not parse. */
function keyDreps(policy: unknown): string[] {
  const script = policy === null ? null : parseNativeScript(bytesFromCol(policy));
  if (!script) return [];
  return [...new Set(collectKeyHashes(script))].map((hash) => drepIdForCredential({ kind: 'key', hash }));
}

async function accountsByDrep(db: D1Database, dreps: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const stmts = keyedStatements(db, OWN.notifyUsers, OWN_WIDTH.notifyUsers, dreps, (d) => [d]);
  if (stmts.length === 0) return out;
  for (const res of await db.batch<Row>(stmts)) {
    for (const r of res.results ?? []) {
      const d = String(r.drep_id);
      out.set(d, [...(out.get(d) ?? []), String(r.id)]);
    }
  }
  return out;
}

/**
 * Drains up to JOIN_NOTIFY_PER_TICK queued join requests, the oldest first. A join whose tx is not fully processed
 * stays queued, so an approval later in the same tx is seen first. A failed notification insert is logged and
 * keeps its rows queued for the next tick.
 */
export async function drainJoinNotifications(db: D1Database, lease: string, _now: number): Promise<{ sent: number }> {
  const page = (await db.prepare(Q.joinNotifyPage.sql).bind(JOIN_NOTIFY_PER_TICK).all<Row>()).results ?? [];
  const drop: EventRef[] = [];
  const pending: PendingJoin[] = [];
  for (const r of page) {
    const join = refFromCols(r.join_tx, r.join_ix);
    if (r.i_tx === null) drop.push(join);
    else if (Number(r.processed) !== 1) continue;
    else if (r.approved_h !== null || r.closed_h !== null || r.eff_h !== null) drop.push(join);
    else {
      pending.push({
        join,
        groupId: groupIdString(refFromCols(r.group_tx, r.group_ix)),
        groupName: r.group_name === null ? null : String(r.group_name),
        memberName: r.member_name === null ? null : String(r.member_name),
        dreps: keyDreps(r.policy),
      });
    }
  }

  // Joins in page order while their key DReps fit one account read.
  const taken: PendingJoin[] = [];
  const dreps = new Set<string>();
  for (const p of pending) {
    const union = new Set([...dreps, ...p.dreps]);
    if (taken.length > 0 && union.size > D1_MAX_BINDS) break;
    taken.push(p);
    for (const d of p.dreps) dreps.add(d);
  }
  const accounts = await accountsByDrep(db, [...dreps]);

  // Then while their notifications fit the cap.
  const notified: EventRef[] = [];
  const rows: GroupNotification[] = [];
  for (const p of taken) {
    const recipients = [...new Set(p.dreps.flatMap((d) => accounts.get(d) ?? []))];
    if (notified.length > 0 && rows.length + recipients.length > MAX_NOTIFY_ROWS) break;
    notified.push(p.join);
    for (const recipientId of recipients) {
      rows.push({
        recipientId,
        type: 'group_join_request',
        eventKey: `group-join:${refKey(p.join)}`,
        payload: { groupId: p.groupId, groupName: p.groupName, ...(p.memberName === null ? {} : { memberName: p.memberName }) },
      });
    }
  }

  let sent = 0;
  if (rows.length > 0) {
    try {
      await insertGroupNotifications(db, rows);
      sent = rows.length;
    } catch (err) {
      console.error(`[drep-groups] join notifications failed for ${notified.length} joins, kept for the next tick`, err);
      notified.length = 0;
    }
  }
  const done = [...drop, ...notified];
  if (done.length > 0) {
    await writeBatch(db, lease, keyedStatements(db, OWN.deleteJoinNotify, OWN_WIDTH.deleteJoinNotify, done, refBinds));
  }
  return { sent };
}
