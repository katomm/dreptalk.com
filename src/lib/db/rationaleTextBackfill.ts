/// <reference types="@cloudflare/workers-types" />
// One-time historical fill: rationales ingested before the FTS migration have
// body_text = '' (the column default). Strip their stored body_html into
// body_text so the _au trigger indexes them. Paced from the vote cron;
// self-draining, a no-op once every ok rationale has text.
import { htmlToText } from '../forum/view.js';

export async function backfillRationaleText(db: D1Database, limit: number): Promise<{ filled: number }> {
  const rows = (
    await db
      .prepare(
        `SELECT ga_id, voter_id, body_html FROM action_rationale
         WHERE body_text = '' AND status = 'ok' AND body_html IS NOT NULL
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ ga_id: string; voter_id: string; body_html: string }>()
  ).results ?? [];
  if (rows.length === 0) return { filled: 0 };
  // Empty strip result stored as a single space so the row leaves this candidate set.
  const stmt = db.prepare('UPDATE action_rationale SET body_text = ? WHERE ga_id = ? AND voter_id = ?');
  await db.batch(rows.map((r) => stmt.bind(htmlToText(r.body_html) || ' ', r.ga_id, r.voter_id)));
  return { filled: rows.length };
}
