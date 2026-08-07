import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { syncCommitteeVoteMeta } from './committeeMetaSync.js';
import { getAllCcMemberNames } from '../db/ccMemberName.js';

const db = () => env.DB;
const hashHex = (s: string) => bytesToHex(blake2b256(new TextEncoder().encode(s)));

async function seedCcVote(gaId: string, voterId: string, hex: string | null, url: string | null, hash: string | null, blockTime: number | null) {
  await db().prepare(`INSERT OR IGNORE INTO governance_actions (id, type, anchor_status, status, created_at, last_synced_at) VALUES (?, 'InfoAction','ok','open',0,0)`).bind(gaId).run();
  await db().prepare(
    `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, meta_url, meta_hash, block_time, synced_at)
     VALUES (?, 'ConstitutionalCommittee', ?, ?, 'Yes', ?, ?, ?, 0)`,
  ).bind(gaId, voterId, hex, url, hash, blockTime).run();
}

describe('syncCommitteeVoteMeta', () => {
  it('stores the CC rationale and the author name from one fetch', async () => {
    const doc = JSON.stringify({ authors: [{ name: 'Eastern Cardano Council' }], body: { comment: 'We support this.' } });
    await seedCcVote('gaCC', 'ccVoter1', 'HOTCC1', 'https://example.com/r.json', hashHex(doc), 1234);
    const r = await syncCommitteeVoteMeta({ db: db(), now: 999, fetchImpl: async () => new Response(doc, { headers: { 'content-type': 'application/json' } }) });
    expect(r.named).toBe(1);
    expect(await getAllCcMemberNames(db())).toEqual([{ hotKeyHex: 'hotcc1', name: 'Eastern Cardano Council', sourceBlockTime: 1234 }]);
    const rat = await db().prepare(`SELECT body_html, status FROM action_rationale WHERE ga_id='gaCC' AND voter_id='ccVoter1'`).first<{ body_html: string; status: string }>();
    expect(rat?.status).toBe('ok');
    expect(rat?.body_html).toContain('We support this');
  });

  it('stores the rationale but no name when block_time is null', async () => {
    const doc = JSON.stringify({ authors: [{ name: 'No Time Org' }], body: { comment: 'ok' } });
    await seedCcVote('gaNT', 'ccVoterNT', 'hotnt', 'https://example.com/nt.json', hashHex(doc), null);
    const r = await syncCommitteeVoteMeta({ db: db(), now: 999, fetchImpl: async () => new Response(doc) });
    expect(r.named).toBe(0);
    expect(await getAllCcMemberNames(db())).toEqual([]);
    const rat = await db().prepare(`SELECT status FROM action_rationale WHERE ga_id='gaNT' AND voter_id='ccVoterNT'`).first<{ status: string }>();
    expect(rat?.status).toBe('ok');
  });

  it('marks a valid but name-less document done (empty) and does not re-queue it', async () => {
    const doc = JSON.stringify({ body: { comment: 'no authors here' } });
    await seedCcVote('gaNN', 'ccVoterNN', 'hotnn', 'https://example.com/nn.json', hashHex(doc), 50);
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(doc); }) as unknown as typeof fetch;
    await syncCommitteeVoteMeta({ db: db(), now: 999, fetchImpl });
    const r2 = await syncCommitteeVoteMeta({ db: db(), now: 1000, fetchImpl });
    expect(r2.fetched).toBe(0); // already resolved (status ok), not refetched
    expect(calls).toBe(1);
  });
});
