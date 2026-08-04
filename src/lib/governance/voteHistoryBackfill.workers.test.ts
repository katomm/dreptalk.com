import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { backfillVoteHistorySweep, supersededFromVoteList } from './voteHistoryBackfill.js';
import type { ActionVoteListRow } from '../koios/client.js';

async function seedAction(id: string) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, 'enacted', 500, NULL, 0, 0)`,
  ).bind(id, `Action ${id}`).run();
}

function feedRow(over: Partial<ActionVoteListRow>): ActionVoteListRow {
  return { voter_id: 'drepA', voter_role: 'DRep', vote: 'Yes', block_time: 1000, meta_url: null, meta_hash: null, ...over };
}

async function historyRows(gaId: string) {
  return (
    await env.DB.prepare(
      'SELECT voter_id, voter_role, vote, block_time, superseded_at FROM drep_vote_history WHERE ga_id = ? ORDER BY voter_id, block_time',
    ).bind(gaId).all<{ voter_id: string; voter_role: string; vote: string; block_time: number; superseded_at: number }>()
  ).results ?? [];
}

describe('supersededFromVoteList', () => {
  it('keeps all but the newest vote per voter, chained by the successor time', () => {
    const rows = supersededFromVoteList([
      feedRow({ block_time: 1000, vote: 'No' }),
      feedRow({ block_time: 2000, vote: 'Abstain' }),
      feedRow({ block_time: 3000, vote: 'Yes' }),
      feedRow({ voter_id: 'drepB', block_time: 1500, vote: 'Yes' }),
    ]);
    expect(rows).toEqual([
      { voterId: 'drepA', voterRole: 'DRep', vote: 'No', metaUrl: null, metaHash: null, blockTime: 1000, supersededAt: 2000 },
      { voterId: 'drepA', voterRole: 'DRep', vote: 'Abstain', metaUrl: null, metaHash: null, blockTime: 2000, supersededAt: 3000 },
    ]);
  });

  it('treats the same voter id in different roles as separate chains', () => {
    const rows = supersededFromVoteList([
      feedRow({ voter_role: 'DRep', block_time: 1000 }),
      feedRow({ voter_role: 'SPO', block_time: 2000 }),
    ]);
    expect(rows).toEqual([]);
  });
});

describe('backfillVoteHistorySweep', () => {
  it('sweeps queued actions, inserts superseded rows, and is a no-op when done', async () => {
    await seedAction('gaS1');
    await seedAction('gaS2');
    const feeds = new Map<string, ActionVoteListRow[]>([
      ['gaS1', [feedRow({ block_time: 1000, vote: 'No' }), feedRow({ block_time: 2000, vote: 'Yes' })]],
      ['gaS2', [feedRow({ voter_id: 'drepB', block_time: 500, vote: 'Yes' })]],
    ]);
    const koios = { actionVoteList: async (id: string) => feeds.get(id) ?? [] };

    const r = await backfillVoteHistorySweep({ koios, db: env.DB, now: 111 });
    expect(r).toMatchObject({ pending: 2, swept: 2, inserted: 1, failed: 0 });

    expect(await historyRows('gaS1')).toEqual([
      { voter_id: 'drepA', voter_role: 'DRep', vote: 'No', block_time: 1000, superseded_at: 2000 },
    ]);
    // A single (current) vote yields no history.
    expect(await historyRows('gaS2')).toEqual([]);

    const r2 = await backfillVoteHistorySweep({ koios, db: env.DB, now: 222 });
    expect(r2).toEqual({ pending: 0, swept: 0, inserted: 0, failed: 0 });
  });

  it('never duplicates rows the live tracking already archived', async () => {
    await seedAction('gaDup');
    await env.DB.prepare(
      `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, meta_url, meta_hash, block_time, body_html, superseded_at)
       VALUES ('gaDup', 'drepA', 'DRep', 'No', NULL, NULL, 1000, '<p>kept</p>', 999)`,
    ).run();
    const koios = {
      actionVoteList: async () => [feedRow({ block_time: 1000, vote: 'No' }), feedRow({ block_time: 2000, vote: 'Yes' })],
    };

    const r = await backfillVoteHistorySweep({ koios, db: env.DB, now: 111 });
    expect(r.inserted).toBe(0);
    // The live-tracked row keeps its body and superseded_at.
    const rows = (
      await env.DB.prepare('SELECT body_html, superseded_at FROM drep_vote_history WHERE ga_id = ?')
        .bind('gaDup').all<{ body_html: string | null; superseded_at: number }>()
    ).results;
    expect(rows).toEqual([{ body_html: '<p>kept</p>', superseded_at: 999 }]);
  });

  it('isolates a failing action and leaves it queued', async () => {
    await seedAction('gaBad');
    await seedAction('gaGood');
    const koios = {
      actionVoteList: async (id: string) => {
        if (id === 'gaBad') throw new Error('koios down');
        return [feedRow({ block_time: 1000, vote: 'No' }), feedRow({ block_time: 2000, vote: 'Yes' })];
      },
    };

    const r = await backfillVoteHistorySweep({ koios, db: env.DB, now: 111 });
    expect(r).toMatchObject({ pending: 2, swept: 1, inserted: 1, failed: 1 });

    const bad = await env.DB.prepare('SELECT vote_history_swept_at FROM governance_actions WHERE id = ?')
      .bind('gaBad').first<{ vote_history_swept_at: number | null }>();
    expect(bad?.vote_history_swept_at).toBeNull();
  });

  it('respects the per-run action cap', async () => {
    await seedAction('gaC1');
    await seedAction('gaC2');
    await seedAction('gaC3');
    const koios = { actionVoteList: async () => [] };

    const r = await backfillVoteHistorySweep({ koios, db: env.DB, now: 111 }, { actionsPerRun: 2 });
    expect(r).toMatchObject({ pending: 3, swept: 2 });
  });
});
