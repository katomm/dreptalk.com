/// <reference types="@cloudflare/workers-types" />
// action_rationale FTS: upsert derives body_text from body_html and the FTS
// index (migration 0043) makes it searchable.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertActionRationale } from './actionRationale.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

describe('action_rationale FTS via upsert', () => {
  it('derives body_text and indexes it for MATCH', async () => {
    await upsertActionRationale(db(), {
      gaId: 'ga1',
      voterId: 'drep1abc',
      bodyHtml: '<p>The <strong>treasury</strong> runway is short.</p>',
      source: 'onchain',
      anchorUrl: 'https://example/x',
      status: 'ok',
      createdAt: NOW,
      now: NOW,
    });

    const row = await db()
      .prepare('SELECT body_text FROM action_rationale WHERE ga_id = ? AND voter_id = ?')
      .bind('ga1', 'drep1abc')
      .first<{ body_text: string }>();
    expect(row?.body_text).toBe('The treasury runway is short.');

    const match = await db()
      .prepare(
        `SELECT r.voter_id FROM action_rationale_fts f
         JOIN action_rationale r ON r.rowid = f.rowid
         WHERE action_rationale_fts MATCH ?1`,
      )
      .bind('treasury')
      .all<{ voter_id: string }>();
    expect(match.results?.map((r) => r.voter_id)).toEqual(['drep1abc']);
  });

  it('reindexes on update (no stale term)', async () => {
    await upsertActionRationale(db(), {
      gaId: 'ga2', voterId: 'drep1def', bodyHtml: '<p>alpha budget</p>',
      source: 'onchain', anchorUrl: null, status: 'ok', createdAt: NOW, now: NOW,
    });
    // second fetch replaces the body
    await upsertActionRationale(db(), {
      gaId: 'ga2', voterId: 'drep1def', bodyHtml: '<p>omega treasury</p>',
      source: 'onchain', anchorUrl: null, status: 'ok', createdAt: NOW, now: NOW,
    });
    const stale = await db().prepare(`SELECT COUNT(*) AS n FROM action_rationale_fts WHERE action_rationale_fts MATCH ?1`).bind('alpha').first<{ n: number }>();
    const fresh = await db().prepare(`SELECT COUNT(*) AS n FROM action_rationale_fts WHERE action_rationale_fts MATCH ?1`).bind('omega').first<{ n: number }>();
    expect(stale?.n).toBe(0);
    expect(fresh?.n).toBe(1);
  });
});
