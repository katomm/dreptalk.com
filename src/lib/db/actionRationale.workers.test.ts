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

  it('reindexes the FTS row on update so the old body leaves no stale term', async () => {
    const ga = `${'f'.repeat(64)}#0`;
    const base = { gaId: ga, voterId: 'drep1def', source: 'onchain' as const, anchorUrl: null, status: 'ok' as const, createdAt: 1000, now: 2000 };
    await upsertActionRationale(env.DB, { ...base, bodyHtml: '<p>alpha budget</p>' });
    // A second fetch replaces the body.
    await upsertActionRationale(env.DB, { ...base, bodyHtml: '<p>omega treasury</p>' });
    const count = async (term: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM action_rationale_fts WHERE action_rationale_fts MATCH ?1`).bind(term).first<{ n: number }>())?.n;
    expect(await count('alpha')).toBe(0);
    expect(await count('omega')).toBe(1);
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

  it('enqueues SPO votes with an anchor, gated by the vote voted_power', async () => {
    const ga = `${'7'.repeat(63)}e#0`;
    const seedSpoVote = (poolId: string, votedPower: number | null) =>
      env.DB
        .prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at, voted_power) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(ga, 'SPO', poolId, 'no', `https://x/${poolId}.json`, 'ee'.repeat(32), 1700000000, 1700000100, votedPower);
    await env.DB.batch([
      seedSpoVote('pool1big', 5_000_000_000_000),
      seedSpoVote('pool1small', 10),
      // Pool power not yet resolved: skipped until the vote sync fills it in.
      seedSpoVote('pool1unresolved', null),
    ]);
    const jobs = await getRationaleFetchQueue(env.DB, { minPower: 1_000_000_000_000, limit: 50 });
    const ids = jobs.map((j) => j.voterId);
    expect(ids).toContain('pool1big');
    expect(ids).not.toContain('pool1small');
    expect(ids).not.toContain('pool1unresolved');
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

  it('retries a failed fetch after a wait that grows with every attempt', async () => {
    const ga = `${'6'.repeat(63)}f#0`;
    const MIN = 60 * 1000;
    const HOUR = 60 * MIN;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO dreps (drep_id, hex, voting_power, status, last_synced_at, created_at) VALUES ('drep1retry','ad','5000000000000','active',0,0)`),
      env.DB.prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at) VALUES (?,?,?,?,?,?,?,?)`).bind(ga, 'DRep', 'drep1retry', 'Yes', 'ipfs://fresh', 'ab'.repeat(32), 1700000000, 1700000100),
    ]);
    const queued = async (now: number) =>
      (await getRationaleFetchQueue(env.DB, { minPower: 1_000_000_000_000, limit: 50, now })).some((j) => j.voterId === 'drep1retry');
    const fail = (now: number) =>
      upsertActionRationale(env.DB, { gaId: ga, voterId: 'drep1retry', bodyHtml: null, source: 'onchain', anchorUrl: 'ipfs://fresh', status: 'failed', createdAt: 1, now });

    // Each retry runs as soon as it is due and fails again.
    const steps: Array<[number, number]> = [
      [29 * MIN, 31 * MIN], // after attempt 1: half an hour, not a day
      [2 * HOUR, 3 * HOUR + MIN], // after attempt 2: three hours
      [23 * HOUR, 24 * HOUR + MIN], // after attempt 3: a day
      [23 * HOUR, 24 * HOUR + MIN], // after attempt 4: a day
    ];
    let t = 1_800_000_000_000;
    for (const [early, due] of steps) {
      await fail(t);
      expect(await queued(t + early)).toBe(false);
      expect(await queued(t + due)).toBe(true);
      t += due;
    }
    // Attempt 5 failed: retries are exhausted.
    await fail(t);
    expect(await queued(t + 30 * 24 * HOUR)).toBe(false);
  });

  it('fetches new anchors before long-failing ones, then by power', async () => {
    const ga = `${'5'.repeat(63)}a#0`;
    const now = 1_900_000_000_000;
    const DAY = 24 * 60 * 60 * 1000;
    const seedDrep = (id: string, power: string) =>
      env.DB.prepare(`INSERT OR REPLACE INTO dreps (drep_id, hex, voting_power, status, last_synced_at, created_at) VALUES (?,?,?,'active',0,0)`).bind(id, `${id}-hex`, power);
    const seedVote = (id: string) =>
      env.DB.prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at) VALUES (?,?,?,?,?,?,?,?)`).bind(ga, 'DRep', id, 'Yes', `ipfs://${id}`, 'ab'.repeat(32), 1700000000, 1700000100);
    await env.DB.batch([
      seedDrep('drep1stale', '9000000000000'), seedVote('drep1stale'),
      seedDrep('drep1early', '8000000000000'), seedVote('drep1early'),
      seedDrep('drep1freshbig', '7000000000000'), seedVote('drep1freshbig'),
      seedDrep('drep1freshsmall', '6000000000000'), seedVote('drep1freshsmall'),
    ]);
    const fail = (id: string, times: number) =>
      env.DB
        .prepare(`INSERT OR REPLACE INTO action_rationale (ga_id, voter_id, body_html, body_text, source, anchor_url, status, attempts, created_at, fetched_at) VALUES (?,?,NULL,'','onchain',?,'failed',?,1,?)`)
        .bind(ga, id, `ipfs://${id}`, times, now - 2 * DAY)
        .run();
    await fail('drep1stale', 4);
    await fail('drep1early', 1);
    const jobs = await getRationaleFetchQueue(env.DB, { minPower: 1_000_000_000_000, limit: 50, now });
    const order = jobs.map((j) => j.voterId).filter((id) => ['drep1stale', 'drep1early', 'drep1freshbig', 'drep1freshsmall'].includes(id));
    expect(order).toEqual(['drep1freshbig', 'drep1freshsmall', 'drep1early', 'drep1stale']);
  });
});
