import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertActionRationale, getActionRationales, getRationaleFetchQueue, countActionRationales } from './actionRationale.js';

const GA = `${'a'.repeat(64)}#0`;

describe('action_rationale', () => {
  it('counts only rows with a readable body from a DRep/SPO voter', async () => {
    const ga = `${'e'.repeat(64)}#0`;
    await env.DB
      .prepare(`INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at) VALUES (?,'DRep','drep1x','Yes',0)`)
      .bind(ga)
      .run();
    await upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1x', bodyHtml: '<p>hi</p>', source: 'onchain', anchorUrl: 'u', status: 'ok', createdAt: 1000, now: 2000 });
    await upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1y', bodyHtml: null, source: 'onchain', anchorUrl: 'u2', status: 'failed', createdAt: 1000, now: 2000 });
    expect(await countActionRationales(env.DB, ga)).toBe(1);
  });

  it('upserts and reads back only rows with body_html, tagged with the voter role', async () => {
    await env.DB
      .prepare(`INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at) VALUES (?,'DRep','drep1a','Yes',0)`)
      .bind(GA)
      .run();
    await upsertActionRationale(env.DB, { gaId: GA, voterId: 'drep1a', bodyHtml: '<p>hi</p>', source: 'onchain', anchorUrl: 'u', status: 'ok', createdAt: 1000, now: 2000 });
    await upsertActionRationale(env.DB, { gaId: GA, voterId: 'drep1b', bodyHtml: null, source: 'onchain', anchorUrl: 'u2', status: 'failed', createdAt: 1000, now: 2000 });
    const map = await getActionRationales(env.DB, GA);
    expect(map.get('drep1a')?.bodyHtml).toBe('<p>hi</p>');
    expect(map.get('drep1a')?.voterRole).toBe('DRep');
    expect(map.has('drep1b')).toBe(false); // failed/empty rows are not shown
  });

  it('re-enqueues a rationale whose stored anchor no longer matches the vote anchor', async () => {
    const ga = `${'9'.repeat(63)}c#0`;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO dreps (drep_id, hex, voting_power, status, last_synced_at, created_at) VALUES ('drep1re','ab','5000000000000','active',0,0)`),
      env.DB.prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at) VALUES (?,?,?,?,?,?,?,?)`).bind(ga, 'DRep', 'drep1re', 'No', 'ipfs://new', 'cc'.repeat(32), 1700000200, 1700000300),
    ]);
    // Stored rationale belongs to the OLD anchor and is status ok.
    await upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1re', bodyHtml: '<p>old</p>', source: 'onchain', anchorUrl: 'ipfs://old', status: 'ok', createdAt: 1, now: 2 });
    const jobs = await getRationaleFetchQueue(env.DB, { minPower: 1_000_000_000_000, limit: 50 });
    const job = jobs.find((j) => j.voterId === 'drep1re');
    expect(job?.anchorUrl).toBe('ipfs://new');
  });

  it('does not enqueue when the stored anchor matches the vote anchor', async () => {
    const ga = `${'8'.repeat(63)}d#0`;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO dreps (drep_id, hex, voting_power, status, last_synced_at, created_at) VALUES ('drep1okk','ac','5000000000000','active',0,0)`),
      env.DB.prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at) VALUES (?,?,?,?,?,?,?,?)`).bind(ga, 'DRep', 'drep1okk', 'No', 'ipfs://same', 'cc'.repeat(32), 1700000200, 1700000300),
    ]);
    await upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1okk', bodyHtml: '<p>cur</p>', source: 'onchain', anchorUrl: 'ipfs://same', status: 'ok', createdAt: 1, now: 2 });
    const jobs = await getRationaleFetchQueue(env.DB, { minPower: 1_000_000_000_000, limit: 50 });
    expect(jobs.find((j) => j.voterId === 'drep1okk')).toBeUndefined();
  });

  it('queue returns above-threshold voters with an anchor and no ok row', async () => {
    const ga2 = `${'b'.repeat(64)}#0`;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO dreps (drep_id, hex, voting_power, status, last_synced_at, created_at) VALUES ('drep1big','aa','5000000000000','active',0,0)`),
      env.DB.prepare(`INSERT OR REPLACE INTO dreps (drep_id, hex, voting_power, status, last_synced_at, created_at) VALUES ('drep1small','bb','10','active',0,0)`),
      env.DB.prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at) VALUES (?,?,?,?,?,?,?,?)`).bind(ga2,'DRep','drep1big','yes','https://x/r.json','cc'.repeat(32),1700000000,1700000100),
      env.DB.prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at) VALUES (?,?,?,?,?,?,?,?)`).bind(ga2,'DRep','drep1small','no','https://x/s.json','dd'.repeat(32),1700000000,1700000100),
    ]);
    const jobs = await getRationaleFetchQueue(env.DB, { minPower: 1_000_000_000_000, limit: 50 });
    const ids = jobs.map((j) => j.voterId);
    expect(ids).toContain('drep1big');
    expect(ids).not.toContain('drep1small'); // below threshold
  });
});
