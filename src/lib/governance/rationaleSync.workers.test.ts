import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { syncVoteRationales } from './rationaleSync.js';
import { getActionRationales } from '../db/actionRationale.js';

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
