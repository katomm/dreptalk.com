/// <reference types="@cloudflare/workers-types" />
// Writes the DRep group notification rows (join requests for admins, signature
// requests for signers). One row per recipient and event_key, so a retried
// writer never double-notifies. All queries use .prepare().bind() exclusively.

import { chunked, D1_MAX_BINDS, DB_NOW_MS } from './sql.js';

export interface GroupNotification {
  recipientId: string;
  type: 'group_join_request' | 'group_signature_request';
  eventKey: string;
  payload: { groupId: string; groupName: string | null; memberName?: string; actionId?: string; summary?: string };
}

// id, recipient_id, type, event_key, payload per row.
const BINDS_PER_ROW = 5;
const ROWS_PER_STATEMENT = Math.floor(D1_MAX_BINDS / BINDS_PER_ROW);

/** Insert statements for the rows, chunked under the bind limit, for callers that batch them with other writes. */
export function groupNotificationStatements(db: D1Database, rows: GroupNotification[]): D1PreparedStatement[] {
  return chunked(rows, ROWS_PER_STATEMENT).map((chunk) =>
    db
      .prepare(
        `INSERT INTO notifications (id, recipient_id, type, event_key, payload, created_at)
         VALUES ${chunk.map(() => `(?, ?, ?, ?, ?, ${DB_NOW_MS})`).join(', ')}
         ON CONFLICT(recipient_id, event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      )
      .bind(
        ...chunk.flatMap((r) => [crypto.randomUUID(), r.recipientId, r.type, r.eventKey, JSON.stringify(r.payload)]),
      ),
  );
}

export async function insertGroupNotifications(db: D1Database, rows: GroupNotification[]): Promise<void> {
  const statements = groupNotificationStatements(db, rows);
  if (statements.length > 0) await db.batch(statements);
}
