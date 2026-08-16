import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { syncVoteRationales } from './rationaleSync.js';
import { getActionRationales } from '../db/actionRationale.js';
import { putVoteRationale } from '../db/voteRationale.js';
import { putDrepMetadata } from '../db/drepMetadata.js';

const GA = `${'c'.repeat(64)}#0`;
const body = JSON.stringify({ body: { comment: 'Synced rationale' } });

function hashOf(s: string): string {
  return bytesToHex(blake2b256(new TextEncoder().encode(s)));
}

describe('syncVoteRationales', () => {
  it('renders an above-threshold voter rationale into action_rationale', async () => {
    const hash = hashOf(body);
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO dreps (drep_id, hex, voting_power, status, last_synced_at, created_at) VALUES ('drep1whale','aa','9000000000000','active',0,0)`),
      env.DB.prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at) VALUES (?,?,?,?,?,?,?,?)`).bind(GA,'DRep','drep1whale','yes','https://x/r.json',hash,1700000000,1700000100),
    ]);
    const fetchImpl = (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const r = await syncVoteRationales({ db: env.DB, now: 1_800_000_000_000, fetchImpl, limit: 10 });
    expect(r.ok).toBe(1);
    const map = await getActionRationales(env.DB, GA);
    expect(map.get('drep1whale')?.bodyHtml).toContain('Synced rationale');
  });
});

// Vote anchors pointing at our own zone must be read from D1 instead of HTTP:
// a same-zone Worker subrequest bypasses our Worker and blackholes at the
// placeholder origin, so the fetch can never be relied on.
describe('syncVoteRationales self-hosted anchors', () => {
  const seedWhale = (drepId: string) =>
    env.DB.prepare(`INSERT OR REPLACE INTO dreps (drep_id, hex, voting_power, status, last_synced_at, created_at) VALUES (?,?,'9000000000000','active',0,0)`).bind(drepId, `${drepId}-hex`);
  const seedVote = (gaId: string, drepId: string, url: string, hash: string) =>
    env.DB.prepare(`INSERT OR REPLACE INTO drep_votes (ga_id, voter_role, voter_id, vote, meta_url, meta_hash, block_time, synced_at) VALUES (?,?,?,?,?,?,?,?)`).bind(gaId, 'DRep', drepId, 'yes', url, hash, 1700000000, 1700000100);
  const throwingFetch: typeof fetch = async (input) => {
    throw new Error('HTTP fetch attempted: ' + String(input));
  };

  it('reads a dreptalk-hosted rationale from the vote_rationale table without HTTP', async () => {
    const ga = `${'d'.repeat(64)}#0`;
    const doc = JSON.stringify({ body: { comment: 'Hosted on DRepTalk itself' } });
    const hash = hashOf(doc);
    await putVoteRationale(env.DB, { hash, body: doc, drepId: 'drep1selfrat', gaId: ga, createdAt: 1000 });
    await env.DB.batch([
      seedWhale('drep1selfrat'),
      seedVote(ga, 'drep1selfrat', `https://dreptalk.com/vote-rationale/${hash}.json`, hash),
    ]);

    const r = await syncVoteRationales({ db: env.DB, now: 1_800_000_000_000, fetchImpl: throwingFetch, limit: 10 });

    expect(r).toMatchObject({ ok: 1, failed: 0 });
    const map = await getActionRationales(env.DB, ga);
    expect(map.get('drep1selfrat')?.bodyHtml).toContain('Hosted on DRepTalk itself');
  });

  it('reads a profile document used as a vote anchor from drep_metadata (empty, terminal)', async () => {
    const ga = `${'e'.repeat(64)}#0`;
    // A CIP-119 profile doc carries no rationale prose: the correct terminal
    // state is 'empty', not an eternal fetch retry.
    const doc = JSON.stringify({ body: { givenName: 'Profile As Anchor' } });
    const hash = hashOf(doc);
    await putDrepMetadata(env.DB, { drepId: 'drep1selfprof', body: doc, hash, name: 'Profile As Anchor', createdAt: 1000 });
    await env.DB.batch([
      seedWhale('drep1selfprof'),
      seedVote(ga, 'drep1selfprof', `https://dreptalk.com/drep/${hash}.json`, hash),
    ]);

    const r = await syncVoteRationales({ db: env.DB, now: 1_800_000_000_000, fetchImpl: throwingFetch, limit: 10 });

    expect(r).toMatchObject({ empty: 1, failed: 0 });
  });

  it('marks a missing self-hosted document failed without attempting HTTP', async () => {
    const ga = `${'f'.repeat(64)}#0`;
    const hash = 'b'.repeat(64);
    await env.DB.batch([
      seedWhale('drep1selfmiss'),
      seedVote(ga, 'drep1selfmiss', `https://dreptalk.com/vote-rationale/${hash}.json`, hash),
    ]);

    const r = await syncVoteRationales({ db: env.DB, now: 1_800_000_000_000, fetchImpl: throwingFetch, limit: 10 });

    expect(r).toMatchObject({ failed: 1, ok: 0 });
  });
});
