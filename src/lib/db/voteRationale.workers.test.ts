import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertVotes, recordLocalVote } from './drepVotes.js';
import { upsertActionRationale } from './actionRationale.js';
import { getVoteStatement, putVoteRationale, gcVoteRationale } from './voteRationale.js';

async function seedAction(id: string) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, title, status, decided_epoch, topic_id, created_at, last_synced_at)
     VALUES (?, 'InfoAction', 'Action', 'enacted', 500, NULL, 0, 0)`,
  ).bind(id).run();
}
async function seedRationale(gaId: string, voterId: string, bodyHtml: string | null, opts?: { status?: string; bodyText?: string }) {
  await upsertActionRationale(env.DB, {
    gaId, voterId, bodyHtml, source: 'dreptalk', anchorUrl: null,
    status: (opts?.status ?? 'ok') as 'ok', createdAt: 0, now: 0,
  });
  if (opts?.bodyText !== undefined) {
    await env.DB.prepare(`UPDATE action_rationale SET body_text = ? WHERE ga_id = ? AND voter_id = ?`)
      .bind(opts.bodyText, gaId, voterId).run();
  }
}

describe('getVoteStatement', () => {
  it('returns a confirmed vote with its rationale (localStatus null)', async () => {
    await seedAction('ga1');
    await upsertVotes(env.DB, 'ga1', [{ voterRole: 'DRep', voterId: 'drepX', voterHex: null, vote: 'Yes' }], 1);
    await seedRationale('ga1', 'drepX', '<p>Because reasons.</p>');
    const row = await getVoteStatement(env.DB, { gaId: 'ga1', voterId: 'drepX', role: 'DRep' });
    expect(row?.vote).toBe('Yes');
    expect(row?.localStatus).toBeNull();
    expect(row?.rationaleHtml).toBe('<p>Because reasons.</p>');
    expect(typeof row?.votingPower === 'string' || row?.votingPower === null).toBe(true);
  });

  it('returns a pending vote with its tx hash', async () => {
    await seedAction('ga2');
    await recordLocalVote(env.DB, { gaId: 'ga2', drepId: 'drepP', voterHex: null, vote: 'No', metaUrl: 'https://x/r', txHash: 'a'.repeat(64), now: 10 });
    await seedRationale('ga2', 'drepP', '<p>Draft reasoning.</p>');
    const row = await getVoteStatement(env.DB, { gaId: 'ga2', voterId: 'drepP', role: 'DRep' });
    expect(row?.localStatus).toBe('pending');
    expect(row?.txHash).toBe('a'.repeat(64));
  });

  it('returns null for a failed vote', async () => {
    await seedAction('ga3');
    await upsertVotes(env.DB, 'ga3', [{ voterRole: 'DRep', voterId: 'drepF', voterHex: null, vote: 'Yes' }], 1);
    await seedRationale('ga3', 'drepF', '<p>x</p>');
    await env.DB.prepare(`UPDATE drep_votes SET local_status = 'failed' WHERE ga_id = 'ga3' AND voter_id = 'drepF'`).run();
    expect(await getVoteStatement(env.DB, { gaId: 'ga3', voterId: 'drepF', role: 'DRep' })).toBeNull();
  });

  it('returns null when the rationale is missing or blank', async () => {
    await seedAction('ga4');
    await upsertVotes(env.DB, 'ga4', [{ voterRole: 'DRep', voterId: 'drepN', voterHex: null, vote: 'No' }], 1);
    expect(await getVoteStatement(env.DB, { gaId: 'ga4', voterId: 'drepN', role: 'DRep' })).toBeNull();
    await seedRationale('ga4', 'drepN', '<p>&nbsp;</p>', { bodyText: ' ' });
    expect(await getVoteStatement(env.DB, { gaId: 'ga4', voterId: 'drepN', role: 'DRep' })).toBeNull();
  });

  it('scopes by role and returns voted_power from vote-time snapshot', async () => {
    await seedAction('ga5');
    await upsertVotes(env.DB, 'ga5', [{ voterRole: 'SPO', voterId: 'poolZ', voterHex: null, vote: 'Yes' }], 1);
    await seedRationale('ga5', 'poolZ', '<p>Pool view.</p>', { status: 'ok' });
    expect(await getVoteStatement(env.DB, { gaId: 'ga5', voterId: 'poolZ', role: 'DRep' })).toBeNull();
    const spoRow = await getVoteStatement(env.DB, { gaId: 'ga5', voterId: 'poolZ', role: 'SPO' });
    expect(spoRow?.vote).toBe('Yes');
    // Verify voted_power is returned correctly (SPO case ensures it works even when dreps row won't match)
    await env.DB.prepare(`UPDATE drep_votes SET voted_power = ? WHERE ga_id = ? AND voter_id = ?`)
      .bind('12500000', 'ga5', 'poolZ').run();
    const spoRowWithPower = await getVoteStatement(env.DB, { gaId: 'ga5', voterId: 'poolZ', role: 'SPO' });
    expect(spoRowWithPower?.votingPower).toBe('12500000');
  });
});

describe('gcVoteRationale', () => {
  const OLD = 1_000;
  const RECENT = 1_000_000;
  const CUTOFF = 500_000;
  const h = (c: string) => c.repeat(64);

  async function seedDoc(hash: string, createdAt: number) {
    await putVoteRationale(env.DB, { hash, body: `{"doc":"${hash}"}`, drepId: 'drep1gc', gaId: `${'a'.repeat(64)}#0`, createdAt });
  }

  async function seedVote(table: 'drep_votes' | 'drep_vote_history', gaSuffix: string, metaUrl: string | null, metaHash: string | null) {
    if (table === 'drep_votes') {
      await env.DB.prepare(
        `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, meta_hash, block_time, synced_at)
         VALUES (?, 'DRep', 'drep1gcvoter', NULL, 'yes', ?, ?, 1, 1)`,
      ).bind(`ga-gc-${gaSuffix}`, metaUrl, metaHash).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, meta_url, meta_hash, block_time, body_html, superseded_at)
         VALUES (?, 'drep1gcvoter', 'DRep', 'no', ?, ?, 1, NULL, 2)`,
      ).bind(`ga-gc-${gaSuffix}`, metaUrl, metaHash).run();
    }
  }

  const stored = async () =>
    ((await env.DB.prepare('SELECT hash FROM vote_rationale ORDER BY hash').all<{ hash: string }>()).results ?? []).map((r) => r.hash);

  it('deletes old documents no vote anchors, and keeps every anchored or recent one', async () => {
    await seedDoc(h('1'), OLD); // anchored by hash on a vote
    await seedDoc(h('2'), OLD); // anchored by URL only (vote synced before meta_hash capture)
    await seedDoc(h('3'), OLD); // anchored by a superseded vote
    await seedDoc(h('4'), OLD); // never anchored: junk
    await seedDoc(h('5'), RECENT); // never anchored yet, but inside the grace period
    await seedVote('drep_votes', '1', 'ipfs://elsewhere', h('1'));
    await seedVote('drep_votes', '2', `https://dreptalk.com/vote-rationale/${h('2')}.json`, null);
    await seedVote('drep_vote_history', '3', `https://preprod.dreptalk.com/vote-rationale/${h('3')}.json`, h('3'));

    const res = await gcVoteRationale(env.DB, { olderThanSec: CUTOFF });
    expect(res).toEqual({ scanned: 4, deleted: 1 });
    expect(await stored()).toEqual([h('1'), h('2'), h('3'), h('5')]);
  });

  it('is a no-op when nothing is past the grace period', async () => {
    await seedDoc(h('6'), RECENT);
    expect(await gcVoteRationale(env.DB, { olderThanSec: CUTOFF })).toEqual({ scanned: 0, deleted: 0 });
    expect(await stored()).toEqual([h('6')]);
  });
});
