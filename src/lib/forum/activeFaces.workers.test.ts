import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadActiveFaces } from './activeFaces.js';

const NOW = 1_700_000_000_000;
const CUTOFF = NOW - 30 * 24 * 60 * 60 * 1000;

async function seedUser(
  id: string,
  o: { isDrep?: boolean; isSpo?: boolean; drepId?: string; poolId?: string; name?: string; lastSeen?: number } = {},
) {
  await env.DB.prepare(
    `INSERT INTO users (id, drep_id, pool_id, is_drep, is_spo, is_cc, is_proposer, role, status, display_name, created_at, last_verified_at, last_seen)
     VALUES (?, ?, ?, ?, ?, 0, 0, 'member', 'active', ?, 0, 0, ?)`,
  )
    .bind(id, o.drepId ?? null, o.poolId ?? null, o.isDrep ? 1 : 0, o.isSpo ? 1 : 0, o.name ?? null, o.lastSeen ?? NOW)
    .run();
}
async function seedDrep(drepId: string, votingPowerLovelace: string, delegatorCount: number) {
  await env.DB.prepare(
    `INSERT INTO dreps (drep_id, status, last_synced_at, created_at, voting_power, delegator_count)
     VALUES (?, 'active', ?, ?, ?, ?)`,
  )
    .bind(drepId, NOW, NOW, votingPowerLovelace, delegatorCount)
    .run();
}
async function seedPool(poolId: string, ticker: string) {
  await env.DB.prepare(`INSERT INTO pools (pool_id, ticker) VALUES (?, ?)`).bind(poolId, ticker).run();
}

describe('loadActiveFaces', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM dreps');
    await env.DB.exec('DELETE FROM pools');
    await env.DB.exec('DELETE FROM users');
  });

  it('builds DRep faces with voting power, delegators, last active and a profile link', async () => {
    await seedUser('u-drep', { isDrep: true, drepId: 'drep1abc', name: 'Ada Governance', lastSeen: NOW - 2 * 24 * 3600 * 1000 });
    await seedDrep('drep1abc', String(12_500_000n * 1_000_000n), 1204);

    const faces = await loadActiveFaces(env.DB, CUTOFF, 10, NOW);
    expect(faces).toHaveLength(1);
    const f = faces[0];
    expect(f.author.displayName).toBe('Ada Governance');
    expect(f.role).toBe('DRep');
    expect(f.href).toBe('/dreps/drep1abc/');
    expect(f.lastActive).toBe('2d ago');
    expect(f.votingPower).toBe('12.5M ₳');
    expect(f.delegators).toBe(1204);
    expect(f.ticker).toBeNull();
  });

  it('builds SPO faces with the pool ticker and no DRep stats', async () => {
    await seedUser('u-spo', { isSpo: true, poolId: 'pool1x', name: 'Stake Pool Alpha', lastSeen: NOW - 3600 * 1000 });
    await seedPool('pool1x', 'STAKE');

    const faces = await loadActiveFaces(env.DB, CUTOFF, 10, NOW);
    expect(faces).toHaveLength(1);
    const f = faces[0];
    expect(f.role).toBe('SPO');
    expect(f.href).toBe('/spos/pool1x/');
    expect(f.ticker).toBe('STAKE');
    expect(f.votingPower).toBeNull();
    expect(f.delegators).toBeNull();
  });

  it('orders newest first and respects the limit', async () => {
    await seedUser('d0', { isDrep: true, drepId: 'drep1d0', lastSeen: NOW - 10 });
    await seedUser('d1', { isDrep: true, drepId: 'drep1d1', lastSeen: NOW - 20 });
    await seedUser('d2', { isDrep: true, drepId: 'drep1d2', lastSeen: NOW - 30 });
    const faces = await loadActiveFaces(env.DB, CUTOFF, 2, NOW);
    expect(faces.map((f) => f.author.authorId)).toEqual(['d0', 'd1']);
  });
});
