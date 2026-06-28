import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertActionRationale, getActionRationales, getRationaleFetchQueue } from './actionRationale.js';

const GA = `${'a'.repeat(64)}#0`;

describe('action_rationale', () => {
  it('upserts and reads back only rows with body_html', async () => {
    await upsertActionRationale(env.DB, { gaId: GA, voterId: 'drep1a', bodyHtml: '<p>hi</p>', source: 'onchain', anchorUrl: 'u', status: 'ok', createdAt: 1000, now: 2000 });
    await upsertActionRationale(env.DB, { gaId: GA, voterId: 'drep1b', bodyHtml: null, source: 'onchain', anchorUrl: 'u2', status: 'failed', createdAt: 1000, now: 2000 });
    const map = await getActionRationales(env.DB, GA);
    expect(map.get('drep1a')?.bodyHtml).toBe('<p>hi</p>');
    expect(map.has('drep1b')).toBe(false); // failed/empty rows are not shown
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
