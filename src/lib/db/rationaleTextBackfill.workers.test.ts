/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { backfillRationaleText } from './rationaleTextBackfill.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

// Insert a pre-migration-style row: body_html present, body_text still the '' default.
async function seedRow(o: { gaId: string; voterId: string; bodyHtml: string | null; status?: string }) {
  await db()
    .prepare(
      `INSERT INTO action_rationale (ga_id, voter_id, body_html, body_text, source, anchor_url, status, attempts, created_at, fetched_at)
       VALUES (?, ?, ?, '', 'onchain', NULL, ?, 1, ?, ?)`,
    )
    .bind(o.gaId, o.voterId, o.bodyHtml, o.status ?? 'ok', NOW, NOW)
    .run();
}

describe('backfillRationaleText', () => {
  it('fills body_text and makes rows searchable, then drains', async () => {
    await seedRow({ gaId: 'g1', voterId: 'd1', bodyHtml: '<p>treasury runway</p>' });
    await seedRow({ gaId: 'g2', voterId: 'd2', bodyHtml: '<p>constitution guardrails</p>' });
    await seedRow({ gaId: 'g3', voterId: 'd3', bodyHtml: null, status: 'failed' }); // ineligible

    const first = await backfillRationaleText(db(), 50);
    expect(first.filled).toBe(2);

    const hit = await db()
      .prepare(`SELECT COUNT(*) AS n FROM action_rationale_fts WHERE action_rationale_fts MATCH ?1`)
      .bind('treasury')
      .first<{ n: number }>();
    expect(hit?.n).toBe(1);

    const second = await backfillRationaleText(db(), 50);
    expect(second.filled).toBe(0); // drained
  });

  it('stores a single space when the strip yields nothing, so it drains', async () => {
    await seedRow({ gaId: 'g4', voterId: 'd4', bodyHtml: '<p></p>' });
    const r1 = await backfillRationaleText(db(), 50);
    expect(r1.filled).toBe(1);
    const row = await db().prepare('SELECT body_text FROM action_rationale WHERE ga_id=? AND voter_id=?').bind('g4', 'd4').first<{ body_text: string }>();
    expect(row?.body_text).toBe(' ');
    const r2 = await backfillRationaleText(db(), 50);
    expect(r2.filled).toBe(0);
  });
});
