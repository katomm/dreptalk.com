// Workers test for listPassCandidates against a real miniflare D1 binding.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { listPassCandidates } from './drepVotes.js';

const GA_ID = 'ga-pass-candidates-test';
const OTHER_GA = 'ga-pass-candidates-other';

async function drep(id: string, active: 0 | 1, power: string | null, name: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO dreps (drep_id, hex, has_script, status, active, voting_power, name, last_synced_at, created_at)
     VALUES (?, ?, 0, 'active', ?, ?, ?, 1, 1)`,
  )
    .bind(id, `hex-${id}`, active, power, name)
    .run();
}

async function vote(gaId: string, id: string, v: string, localStatus: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, synced_at, local_status)
     VALUES (?, 'DRep', ?, ?, ?, 1, ?)`,
  )
    .bind(gaId, id, `hex-${id}`, v, localStatus)
    .run();
}

describe('listPassCandidates', () => {
  it('returns active non-voters plus No and Abstain voters, nothing else', async () => {
    await drep('drep_a', 1, '9007199254740993', 'Alice');
    await env.DB.prepare(`UPDATE dreps SET slug = 'alice' WHERE drep_id = 'drep_a'`).run();
    await drep('drep_b', 0, '500');
    await drep('drep_c', 1, '300');
    await drep('drep_d', 0, '200');
    await drep('drep_e', 1, '700');
    await drep('drep_f', 1, null);
    await drep('drep_g', 1, 'abc');
    await drep('drep_always_abstain', 1, '99999');
    await drep('drep_always_no_confidence', 1, '88888');
    await drep('drep_h', 1, '150');
    await drep('drep_i', 1, '40');
    await drep('drep_j', 1, '30');
    await drep('drep_k', 1, '0');
    await vote(GA_ID, 'drep_c', 'No');
    await vote(GA_ID, 'drep_d', 'Abstain');
    await vote(GA_ID, 'drep_e', 'Yes');
    await vote(GA_ID, 'drep_h', 'yes', 'failed');
    await vote(GA_ID, 'drep_i', 'no', 'pending');
    await vote(GA_ID, 'drep_j', 'abstain', 'pending');
    await vote(OTHER_GA, 'drep_a', 'Yes');
    await vote(OTHER_GA, 'drep_b', 'No');

    const rows = (await listPassCandidates(env.DB, GA_ID))!;
    const byId = Object.fromEntries(rows.map((r) => [r.drepId, r]));
    expect(Object.keys(byId).sort()).toEqual(['drep_a', 'drep_c', 'drep_d', 'drep_h', 'drep_i', 'drep_j']);
    expect(byId.drep_a).toEqual({ drepId: 'drep_a', slug: 'alice', name: 'Alice', power: 9007199254740993n, stance: 'notVoted' });
    expect(byId.drep_c.stance).toBe('No');
    expect(byId.drep_d.stance).toBe('Abstain');
    expect(byId.drep_h.stance).toBe('notVoted');
    expect(byId.drep_i.stance).toBe('No');
    expect(byId.drep_j.stance).toBe('Abstain');
  });

  it('returns null when D1 throws', async () => {
    const broken = {
      prepare: () => {
        throw new Error('D1 down');
      },
    } as unknown as D1Database;
    expect(await listPassCandidates(broken, GA_ID)).toBeNull();
  });
});
