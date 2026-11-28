import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { countActionsByReturnAddress, countEnactedWithoutPayload, listAllTreasuryRows, listTreasuryHistoryRows } from './treasury.js';
import { listEpochBalances } from './governanceEpochStats.js';

const PROPOSER = 'stake_test1uqproposer';
const PAY = JSON.stringify({ tag: 'TreasuryWithdrawals', contents: [[[{ credential: { scriptHash: 'a'.repeat(56) } }, 1]], null] });

async function seedAction(id: string, over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    id, type: 'TreasuryWithdrawals', anchor_status: 'ok', status: 'enacted', created_at: 0, last_synced_at: 0,
    return_address: null, submitted_epoch: 1, submitted_at: null, onchain_payload: PAY, topic_id: null, ...over,
  };
  const cols = Object.keys(base);
  await env.DB.prepare(
    `INSERT INTO governance_actions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).bind(...cols.map((c) => base[c])).run();
}

// topics.id is TEXT, so ids are inlined as text literals (a bound number would become "1.0").
async function seedTopic(id: string, slug: string, deleted: 0 | 1) {
  await env.DB.prepare(
    `INSERT INTO topics (id, category_slug, author_id, title, slug, last_post_at, created_at, deleted)
     VALUES ('${id}', 'general', 'author1', 't', ?, 0, 0, ?)`,
  ).bind(slug, deleted).run();
}

beforeEach(async () => {
  await seedTopic('1', 'slug-1', 0);
  await seedTopic('3', 'slug-3', 1);
  await seedAction('v', { return_address: PROPOSER, submitted_at: 500 });
  await seedAction('t1', { return_address: PROPOSER, submitted_at: 200, topic_id: '1' });
  await seedAction('t2', { submitted_at: 300 });
  await seedAction('t3', { submitted_at: 150, topic_id: '3' });
  await seedAction('t4', { submitted_at: null, submitted_epoch: 9 });
  await seedAction('t5', { submitted_at: 100, onchain_payload: '{nope' });
  await seedAction('info', { type: 'InfoAction', return_address: PROPOSER, onchain_payload: null });
  await seedAction('nopay', { onchain_payload: null, submitted_at: 400 });
});

describe('listTreasuryHistoryRows', () => {
  it('lists other treasury rows newest first with live slugs only', async () => {
    const rows = await listTreasuryHistoryRows(env.DB, 'v');
    expect(rows.map((r) => [r.id, r.slug])).toEqual([
      ['t2', null],
      ['t1', 'slug-1'],
      ['t3', null],
      ['t5', null],
      ['t4', null],
    ]);
    // The broken payload text is passed through, the builder skips it.
    expect(rows.find((r) => r.id === 't5')!.payload).toBe('{nope');
    expect(rows.find((r) => r.id === 't1')).toMatchObject({ returnAddress: PROPOSER, submittedAt: 200, submittedEpoch: 1, status: 'enacted' });
  });
});

describe('countActionsByReturnAddress', () => {
  it('counts every action from a return address', async () => {
    expect(await countActionsByReturnAddress(env.DB, PROPOSER)).toBe(3);
    expect(await countActionsByReturnAddress(env.DB, null)).toBeNull();
  });
});

describe('listAllTreasuryRows', () => {
  it('lists every treasury withdrawal with its enacted epoch', async () => {
    await env.DB.prepare("UPDATE governance_actions SET enacted_epoch = 7 WHERE id = 't1'").run();
    const rows = await listAllTreasuryRows(env.DB);
    expect(rows.map((r) => r.id)).toEqual(['v', 't2', 't1', 't3', 't5', 't4']);
    expect(rows.find((r) => r.id === 't1')).toMatchObject({ enactedEpoch: 7, slug: 'slug-1', returnAddress: PROPOSER });
    expect(rows.find((r) => r.id === 't2')?.enactedEpoch).toBeNull();
  });
});

describe('listEpochBalances', () => {
  it('lists epoch balances with nulls kept', async () => {
    const ins = (e: number, t: string | null, r: string | null) =>
      env.DB.prepare(
        `INSERT INTO governance_epoch_stats (epoch, total_drep_power, powered_drep_count, recently_voting_drep_count, gini,
           top10_share_pct, min_coalition_50, min_coalition_67, votes_cast, vote_data_complete, treasury_lovelace, reserves_lovelace, computed_at)
         VALUES (?, '0', 0, 0, 0, 0, 0, 0, 0, 1, ?, ?, 0)`,
      ).bind(e, t, r).run();
    await ins(500, '1', '9');
    await ins(502, '3', null);
    await ins(501, '2', '8');
    expect(await listEpochBalances(env.DB, 501)).toEqual([
      { epoch: 501, treasury: 2n, reserves: 8n },
      { epoch: 502, treasury: 3n, reserves: null },
    ]);
  });
});

describe('countEnactedWithoutPayload', () => {
  it('counts enacted treasury withdrawals stored without a payload', async () => {
    // 'nopay' from beforeEach is enacted without a payload, the InfoAction does not count.
    expect(await countEnactedWithoutPayload(env.DB)).toBe(1);
    await seedAction('nopay2', { onchain_payload: null, status: 'expired' });
    expect(await countEnactedWithoutPayload(env.DB)).toBe(1);
  });
});
